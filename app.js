/* Minhas Finanças — PWA com Supabase */
(() => {
  'use strict';

  const sb = window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseKey);

  // ---------- Constantes ----------
  const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const CATEGORIES = [
    ['Mercado', '🛒'], ['Alimentação', '🍔'], ['Transporte', '🚗'], ['Casa', '🏠'], ['Contas', '💡'],
    ['Saúde', '💊'], ['Lazer', '🎉'], ['Compras', '🛍️'], ['Assinaturas', '📺'], ['Outros', '📦'],
  ];
  const CAT_ICON = Object.assign(Object.create(null), Object.fromEntries(CATEGORIES)); // sem protótipo: "constructor" não vira ícone
  // Cada categoria tem a sua cor fixa (CSS --cat-0..9, na ordem de CATEGORIES); desconhecida = "Outros"
  const catIdx = (c) => { const i = CATEGORIES.findIndex(([n]) => n === c); return i < 0 ? CATEGORIES.length - 1 : i; };
  const catColor = (c) => `var(--cat-${catIdx(c)})`;
  const CAT_DARK_INK = new Set([1, 4, 6, 9]); // cores claras: % escrito em tinta escura (tema claro)
  const CAT_DARK_INK_DARK = new Set([1, 3, 4, 5, 6, 7, 8, 9]); // no tema escuro as cores mudam
  const isDarkTheme = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const COLORS = ['#8a05be', '#ff7a00', '#0b6bcb', '#16a36a', '#d64545', '#111827', '#c2185b', '#00897b'];

  // ---------- Estado ----------
  const now = new Date();
  const state = {
    session: null,
    cards: [],
    expenses: [],
    loadedAt: 0,       // quando os dados foram carregados pela última vez (0 = ainda não)
    loadError: false,  // o primeiro carregamento falhou (mostra "Tentar de novo")
    avatarUrl: null,
    profiles: [],      // perfis extras (família, empresa); o principal não tem linha (profile_id vazio)
    profileId: null,   // perfil ativo (null = principal)
    profilesOk: false, // a tabela de perfis existe no banco (se não, o app funciona como antes, sem perfis)
    budgets: [],       // limite mensal por categoria (perfil ativo)
    incomes: [],       // receitas (salário etc.)
    goals: [],         // metas de economia
    push: 'unknown',   // avisos neste celular: unknown | unsupported | denied | off | on
    tab: 'resumo',
    month: now.getFullYear() * 12 + now.getMonth(), // índice absoluto do mês
  };

  let pushSynced = false; // este celular já foi ligado à conta atual nesta sessão (avisos)

  // ---------- Utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Cor vinda do banco só entra em style="..." se for #rrggbb (impede injetar CSS)
  const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? c : '#8a8f98');
  const brl = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const round2 = (v) => Math.round(v * 100) / 100;
  const pad2 = (n) => String(n).padStart(2, '0');
  const monthName = (idx) => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;
  const daysIn = (idx) => new Date(Math.floor(idx / 12), (idx % 12) + 1, 0).getDate();
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m: m - 1, d }; };
  const fmtDate = (s) => { const { m, d } = parseDate(s); return `${pad2(d)}/${pad2(m + 1)}`; };
  const todayStr = () => { const t = new Date(); return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`; };
  const curIdx = () => { const t = new Date(); return t.getFullYear() * 12 + t.getMonth(); }; // mês de hoje
  const dateStr = (idx, d) => `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}-${pad2(Math.min(d, daysIn(idx)))}`;
  const moneyInput = (v) => Number(v).toFixed(2).replace('.', ',');
  const validMonths = (v) => { v = String(v).trim(); return !v || (/^\d+$/.test(v) && +v >= 1 && +v <= 600); };
  const shortMonth = (idx) => `${MONTHS[idx % 12].slice(0, 3)} ${Math.floor(idx / 12)}`;

  function parseMoney(s) {
    s = String(s).trim().replace(/^R\$/i, '').replace(/\s/g, '');
    if (s.includes(',')) {                                              // 1.234,56 | 1234,5
      if (!/^-?(\d{1,3}(\.\d{3})+|\d+),\d{1,2}$/.test(s)) return NaN;
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 1.500 → 1500 (ponto de milhar)
    else if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;               // 12abc, 1e3, 1,234.56 → inválido
    const v = Number(s);
    return Number.isFinite(v) ? round2(v) : NaN;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2600);
  }

  // ---------- Regras de fatura ----------
  const cardById = (id) => state.cards.find((c) => c.id === id) || null;

  // Mês (índice absoluto) da fatura em que cai a 1ª parcela de uma compra no cartão.
  function invoiceMonth(dateStr, card) {
    const { y, m, d } = parseDate(dateStr);
    let close = y * 12 + m;
    if (d >= card.closing_day) close += 1;         // comprou no dia do fechamento ou depois → próxima fatura
    return card.due_day <= card.closing_day ? close + 1 : close; // vencimento cai no mês seguinte ao fechamento
  }

  // Data de vencimento da fatura de um cartão em determinado mês
  function dueDate(card, idx) {
    return `${pad2(Math.min(card.due_day, daysIn(idx)))}/${pad2((idx % 12) + 1)}`;
  }

  // Mês (índice absoluto) do 1º lançamento de um gasto
  function startMonth(exp, card) {
    if (card) return invoiceMonth(exp.purchase_date, card);
    const { y, m } = parseDate(exp.purchase_date);
    return y * 12 + m;
  }

  // ---------- Contas fixas que mudam de valor ----------
  // recur_changes = [{ from: 'AAAA-MM', amount?, card_id?, split_divisor? }], em ordem de mês: a partir de 'from',
  // os campos presentes substituem os do lançamento; os meses anteriores continuam como eram.
  const MONEY_FIELDS = ['amount', 'card_id', 'split_divisor'];
  const monthKey = (idx) => `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
  const moneyOf = (o) => ({ amount: Number(o.amount), card_id: o.card_id || null, split_divisor: Number(o.split_divisor) || 1 });
  const sameMoney = (a, b) => MONEY_FIELDS.every((f) => a[f] === b[f]);

  // Valor, cartão e divisão que valem no mês idx
  function valuesAt(exp, idx) {
    const key = monthKey(idx);
    const v = moneyOf(exp);
    for (const c of exp.recur_changes || []) if (c.from <= key) for (const f of MONEY_FIELDS) if (f in c) v[f] = c[f];
    return moneyOf(v);
  }

  // Conta fixa editada no mês idx: o que mudou em valor, cartão ou divisão passa a valer a partir de idx
  // (no 1º mês, desde o início). Mudanças já marcadas para meses seguintes continuam valendo.
  function mergeForward(exp, row, idx) {
    const before = valuesAt(exp, idx), want = moneyOf(row), base = moneyOf(exp);
    let changes = (exp.recur_changes || []).map((c) => ({ ...c }));
    let target = base;
    if (idx > startMonth(exp, cardById(exp.card_id))) {
      target = changes.find((c) => c.from === monthKey(idx));
      if (!target) changes.push((target = { from: monthKey(idx) }));
    }
    for (const f of MONEY_FIELDS) if (want[f] !== before[f]) target[f] = want[f];
    changes.sort((a, b) => a.from.localeCompare(b.from));
    // Se a data mudou, as mudanças até o novo 1º mês passam a fazer parte do valor inicial
    const start = monthKey(startMonth(row, cardById(base.card_id)));
    for (const c of changes) if (c.from <= start) for (const f of MONEY_FIELDS) if (f in c) base[f] = c[f];
    changes = changes.filter((c) => c.from > start);
    // Guarda só o que realmente muda em relação ao que já valia antes
    const prev = { ...base }, out = [];
    for (const c of changes) {
      const d = { from: c.from };
      for (const f of MONEY_FIELDS) if (f in c && c[f] !== prev[f]) prev[f] = d[f] = c[f];
      if (Object.keys(d).length > 1) out.push(d);
    }
    return { ...row, ...base, recur_changes: out };
  }

  // Lançamento de um gasto em determinado mês (ou null se não cai nesse mês)
  //  - Única: 1 lançamento | Parcelada: valor total dividido em n | Mensal fixa: valor cheio todo mês (com ou sem fim)
  function entryFor(exp, idx) {
    const k = idx - startMonth(exp, cardById(exp.card_id));
    if (k < 0) return null;
    const v = exp.recurring ? valuesAt(exp, idx) : moneyOf(exp);
    let total, n;
    if (exp.recurring) {
      n = exp.recur_count || null;              // null = sem fim
      if (n && k >= n) return null;
      total = v.amount;
    } else {
      n = exp.installments || 1;
      if (k >= n) return null;
      const per = round2(v.amount / n);
      total = k === n - 1 ? round2(v.amount - per * (n - 1)) : per; // última parcela absorve os centavos
    }
    const mine = round2(total / v.split_divisor);
    return { exp, card: cardById(v.card_id), div: v.split_divisor, inst: k + 1, n, total, mine, hers: round2(total - mine) };
  }

  const entriesForMonth = (idx) => state.expenses.map((e) => entryFor(e, idx)).filter(Boolean);

  // ---------- Receitas ----------
  // Única: entra no mês da data. Mensal: todo mês a partir da data (com ou sem fim); recur_changes = [{ from, amount }]
  const incStart = (inc) => { const { y, m } = parseDate(inc.income_date); return y * 12 + m; };
  function incAmountAt(inc, idx) {
    const key = monthKey(idx);
    let a = Number(inc.amount);
    for (const c of inc.recur_changes || []) if (c.from <= key && 'amount' in c) a = Number(c.amount);
    return a;
  }
  function incomeFor(inc, idx) {
    const k = idx - incStart(inc);
    if (k < 0) return null;
    if (!inc.recurring) return k === 0 ? { inc, amount: Number(inc.amount), inst: 1, n: 1 } : null;
    if (inc.recur_count && k >= inc.recur_count) return null;
    return { inc, amount: incAmountAt(inc, idx), inst: k + 1, n: inc.recur_count || null };
  }
  const incomesForMonth = (idx) => state.incomes.map((i) => incomeFor(i, idx)).filter(Boolean);

  // Receita mensal editada num mês depois do 1º: o valor novo vale daquele mês em diante (igual às contas fixas)
  function incomeForward(inc, row, idx) {
    if (!inc.recurring || !row.recurring) return { ...row, recur_changes: [] };
    const s0 = incStart(inc), key = monthKey(idx);
    let base = Number(inc.amount);
    let changes = (inc.recur_changes || []).map((c) => ({ ...c }));
    if (idx > s0) { // valor novo vale do mês na tela em diante
      changes = changes.filter((c) => c.from !== key);
      if (row.amount !== incAmountAt({ amount: base, recur_changes: changes }, idx)) changes.push({ from: key, amount: row.amount });
      changes.sort((a, b) => a.from.localeCompare(b.from));
    } else base = row.amount; // no 1º mês: muda o valor inicial
    // Data nova mais tarde: o valor inicial passa a ser o que já valia no novo 1º mês
    const s1 = incStart(row);
    if (s1 > s0) base = incAmountAt({ amount: base, recur_changes: changes }, s1);
    // Guarda só as mudanças depois do 1º mês que realmente mudam o valor
    let prev = base;
    const out = [];
    for (const c of changes) if (c.from > monthKey(s1) && Number(c.amount) !== prev) { out.push(c); prev = Number(c.amount); }
    return { ...row, amount: base, recur_changes: out };
  }

  // Texto da parcela: "3/10", "3/60" (financiamento) ou "mensal" (sem fim)
  const instLabel = (e) => (e.exp.recurring && !e.n ? 'mensal' : e.n > 1 ? `${e.inst}/${e.n}` : '');

  // ---------- Dados ----------
  // O Supabase devolve no máximo 1000 linhas por consulta: busca os gastos em páginas até acabar
  async function fetchAllExpenses() {
    const PAGE = 1000;
    const all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await scoped(sb.from('expenses').select('*'))
        .order('purchase_date', { ascending: false }).order('id') // 'id' desempata: páginas sem repetir nem pular linhas
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE) return all;
    }
  }

  // Tabelas extras (limites, receitas, metas): se a leitura falhar devolve null e o app mantém o que já tinha
  const optional = (table, order = 'created_at') =>
    scoped(sb.from(table).select('*')).order(order).then((r) => (r.error ? null : r.data), () => null);

  // Cada carregamento ganha um número; a resposta é descartada se outro carregamento começou,
  // se um formulário foi aberto (para não sobrescrever o que for salvo nele) ou se saiu da conta.
  let loadSeq = 0;
  async function loadData() {
    const seq = ++loadSeq;
    try {
      await loadProfiles();
      if (seq !== loadSeq) return;
      const [c, expenses, budgets, incomes, goals] = await Promise.all([
        scoped(sb.from('cards').select('*')).order('created_at'), fetchAllExpenses(),
        optional('budgets'), optional('incomes', 'income_date'), optional('goals'),
      ]);
      if (c.error) throw c.error;
      if (seq !== loadSeq) return;
      Object.assign(state, {
        cards: c.data, expenses, budgets: budgets ?? state.budgets, incomes: incomes ?? state.incomes, goals: goals ?? state.goals,
        loadedAt: Date.now(), loadError: false,
      });
      if ($('#toast').textContent.startsWith('Erro ao carregar')) $('#toast').hidden = true; // erro antigo do "Tentar de novo"
    } catch (err) {
      if (seq !== loadSeq || state.loadedAt) return; // falhou só a atualização: mantém o que já está na tela
      state.loadError = true;
      toast('Erro ao carregar dados: ' + err.message);
    }
    render();
  }

  // ---------- Perfis ----------
  // Cada perfil tem os seus cartões e gastos. Só os dados do perfil ativo são carregados.
  const profileKey = () => `profile:${state.session?.user?.id}`;
  const activeProfile = () => state.profiles.find((p) => p.id === state.profileId) || null;
  const profileName = (p) => (p ? p.name : 'Principal');
  // Filtra a consulta pelo perfil ativo (sem a tabela de perfis no banco, não filtra nada)
  const scoped = (q) => (!state.profilesOk ? q : state.profileId ? q.eq('profile_id', state.profileId) : q.is('profile_id', null));
  // Linha nova ganha o perfil ativo
  const withProfile = (row) => (state.profilesOk ? { ...row, profile_id: state.profileId } : row);

  async function loadProfiles() {
    const { data, error } = await sb.from('profiles').select('*').order('created_at');
    state.profilesOk = !error;
    state.profiles = error ? [] : data;
    if (state.profileId === null) { try { state.profileId = localStorage.getItem(profileKey()) || null; } catch {} }
    if (state.profileId && !state.profiles.some((p) => p.id === state.profileId)) state.profileId = null; // perfil apagado
  }

  function switchProfile(id) {
    if (id === state.profileId) return;
    state.profileId = id;
    try { id ? localStorage.setItem(profileKey(), id) : localStorage.removeItem(profileKey()); } catch {}
    loadSeq++; // descarta carregamento do perfil anterior
    Object.assign(state, { cards: [], expenses: [], budgets: [], incomes: [], goals: [], loadedAt: 0, loadError: false });
    if (state.tab === 'resumo') render(); else setTab('resumo');
    loadData();
    toast(`Perfil: ${profileName(activeProfile())}`);
  }

  // Ao voltar para o app: recarrega se o carregamento falhou ou se os dados têm mais de 5 min
  // (ex.: gastos lançados em outro aparelho enquanto este ficou aberto)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.session) return;
    refreshPush(); // a permissão pode ter mudado nas configurações do celular
    if (Date.now() - avatarAt > 50 * 60 * 1000) loadAvatar(); // o link da foto vale 1 h
    if (!$('#sheet').hidden) return;
    if (Date.now() - state.loadedAt > 5 * 60 * 1000) loadData();
  });

  // ---------- Autenticação ----------
  let signUpMode = false;

  function showAuth() { $('#auth').hidden = false; $('#app').hidden = true; }
  function showApp() { $('#auth').hidden = true; $('#app').hidden = false; render(); loadData(); loadAvatar(); refreshPush(); }

  $('#auth-toggle').onclick = () => {
    signUpMode = !signUpMode;
    $('#auth-submit').textContent = signUpMode ? 'Criar conta' : 'Entrar';
    $('#auth-toggle').textContent = signUpMode ? 'Já tem conta? Entrar' : 'Não tem conta? Criar conta';
    $('#auth-msg').textContent = '';
  };

  $('#auth-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const email = f.get('email').trim();
    const password = f.get('password');
    const msg = $('#auth-msg');
    const btn = $('#auth-submit');
    msg.className = 'msg';
    msg.textContent = '';
    btn.disabled = true;
    try {
      if (signUpMode) {
        if (password.length < 8 || !/[a-z]/i.test(password) || !/\d/.test(password)) {
          throw new Error('A senha precisa ter pelo menos 8 caracteres, com letras e números.');
        }
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        if (!data.session) msg.textContent = 'Conta criada! Confira seu e-mail para confirmar e depois entre.';
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = translateAuthError(err.message);
    } finally {
      btn.disabled = false;
    }
  };

  function translateAuthError(m) {
    if (/invalid login/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/not confirmed/i.test(m)) return 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada).';
    if (/already registered/i.test(m)) return 'Este e-mail já tem conta. Use "Entrar".';
    if (/at least 6/i.test(m)) return 'A senha precisa ter pelo menos 6 caracteres.';
    return m;
  }

  sb.auth.onAuthStateChange((_evt, session) => {
    const had = !!state.session;
    state.session = session;
    if (session && !had) showApp();
    if (!session) {
      loadSeq++; // descarta carregamentos em andamento
      pushSynced = false;
      Object.assign(state, { cards: [], expenses: [], budgets: [], incomes: [], goals: [], profiles: [], profileId: null, profilesOk: false, avatarUrl: null, loadedAt: 0, loadError: false });
      if (state.tab !== 'resumo') setTab('resumo'); // próxima entrada começa no Resumo
      showAuth();
    }
  });

  // ---------- Navegação ----------
  const isMonthlyTab = () => !['cartoes', 'menu'].includes(state.tab); // abas com ‹ mês ›

  // ---------- Botão "voltar" do celular ----------
  // Histórico: [base] → [outra aba] → [formulário aberto]. Voltar fecha o formulário, depois volta ao Resumo,
  // e só então sai do app.
  const nav = { tabPushed: false, sheetPushed: false, ignorePop: 0 };
  history.replaceState({ base: true }, '');
  function historyBack() { nav.ignorePop++; history.back(); }

  function setTab(tab, fromPop = false) {
    if (!fromPop) {
      if (tab !== 'resumo' && !nav.tabPushed) { history.pushState({ tab: true }, ''); nav.tabPushed = true; }
      else if (tab === 'resumo' && nav.tabPushed) { nav.tabPushed = false; historyBack(); }
    }
    state.tab = tab;
    document.querySelectorAll('.tabbar button[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    render();
    window.scrollTo(0, 0);
  }

  window.addEventListener('popstate', () => {
    if (nav.ignorePop > 0) {
      nav.ignorePop--;
      if (!nav.ignorePop && nav.pushAfterPop) { nav.pushAfterPop = false; history.pushState({ sheet: true }, ''); }
      return;
    }
    if (nav.sheetPushed) { nav.sheetPushed = false; closeSheet(true); return; }
    if (nav.tabPushed) { nav.tabPushed = false; setTab('resumo', true); }
  });

  document.querySelectorAll('.tabbar button[data-tab]').forEach((b) => {
    b.onclick = () => { if (b.dataset.tab !== state.tab) setTab(b.dataset.tab); };
  });
  function changeMonth(delta) {
    state.month += delta;
    render();
    const v = $('#view');
    v.classList.remove('slide-next', 'slide-prev');
    void v.offsetWidth; // reinicia a animação
    v.classList.add(delta > 0 ? 'slide-next' : 'slide-prev');
  }
  $('#prev-month').onclick = () => changeMonth(-1);
  $('#next-month').onclick = () => changeMonth(1);

  // Deslizar o dedo para trocar de mês (esquerda = próximo, direita = anterior)
  (() => {
    let x0 = null, y0 = 0, t0 = 0;
    const EDGE = 28; // ignora a borda da tela (gesto "voltar" do Android)
    document.addEventListener('touchstart', (e) => {
      x0 = null;
      if (e.touches.length !== 1 || !$('#sheet').hidden || $('#app').hidden || !isMonthlyTab()) return;
      const t = e.touches[0];
      if (t.clientX < EDGE || t.clientX > innerWidth - EDGE) return;
      if (t.target.closest('input, select, textarea, .tabbar')) return;
      x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      if (Date.now() - t0 > 700) return;                               // arrasto lento demais
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return; // curto ou mais vertical (rolagem)
      changeMonth(dx < 0 ? 1 : -1);
    }, { passive: true });
  })();
  $('#profile-pill').onclick = openProfilePicker;
  $('#fab').onclick = () => (state.tab === 'cartoes' ? openCardForm() : openExpenseForm());

  // ---------- Render ----------
  function render() {
    const monthly = isMonthlyTab();
    const waiting = !state.loadedAt && state.tab !== 'menu'; // dados ainda não chegaram (ou falharam)
    $('#month-title').textContent = monthly ? monthName(state.month) : (state.tab === 'menu' ? 'Menu' : 'Cartões');
    // Com mais de um perfil, mostra qual está ativo (toque para trocar)
    const pill = $('#profile-pill');
    pill.hidden = !state.profiles.length || state.tab === 'menu';
    if (!pill.hidden) pill.innerHTML = `${profileIcon(activeProfile())} ${esc(profileName(activeProfile()))} <span aria-hidden="true">▾</span>`;
    $('#prev-month').style.visibility = monthly ? 'visible' : 'hidden';
    $('#next-month').style.visibility = monthly ? 'visible' : 'hidden';
    $('#fab').hidden = state.tab === 'menu' || waiting;
    $('.tabbar').classList.toggle('no-fab', $('#fab').hidden); // sem o "+", os 4 ícones se espalham por igual
    $('#fab').setAttribute('aria-label', state.tab === 'cartoes' ? 'Novo cartão' : 'Novo gasto');
    const views = { resumo: renderResumo, gastos: renderGastos, cartoes: renderCartoes, menu: renderMenu };
    $('#view').innerHTML = waiting ? renderWaiting() : views[state.tab]();
    paintAvatars();
    bindView();
  }

  // Enquanto os dados não chegam: "Carregando…" ou, se falhou, um botão para tentar de novo
  function renderWaiting() {
    if (!state.loadError) return emptyState('Carregando…', '');
    return emptyState('Não foi possível carregar seus dados', 'Confira sua conexão com a internet.',
      '<div style="margin-top:14px"><button class="btn primary small" id="retry">Tentar de novo</button></div>');
  }

  function renderResumo() {
    const list = entriesForMonth(state.month);
    const incs = incomesForMonth(state.month);
    const spent = round2(list.reduce((s, e) => s + e.mine, 0));
    const onCard = round2(list.filter((e) => e.card).reduce((s, e) => s + e.mine, 0));
    const income = round2(incs.reduce((s, i) => s + i.amount, 0));
    const left = round2(income - spent);

    const byCat = {};
    list.forEach((e) => { byCat[e.exp.category] = (byCat[e.exp.category] || 0) + e.mine; });
    const cats = Object.entries(byCat).map(([c, v]) => [c, round2(v)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

    const byPay = {};
    list.forEach((e) => { const k = e.card ? e.card.name : 'Pix / boleto / dinheiro'; byPay[k] = (byPay[k] || 0) + e.mine; });

    return `
      ${state.month === curIdx() ? dueAlerts() : ''}
      <section class="card hero">
        <div class="label">Gastos do mês</div>
        <div class="big num">${brl(spent)}</div>
        <div class="hero-row">
          <div><small>No cartão</small><b class="num">${brl(onCard)}</b></div>
          <div><small>Pix / boleto / dinheiro</small><b class="num">${brl(round2(spent - onCard))}</b></div>
        </div>
        ${income > 0 ? `
        <div class="hero-row hero-bal">
          <div><small>Receitas</small><b class="num">${brl(income)}</b></div>
          <div class="${left < 0 ? 'neg' : ''}"><small>${left < 0 ? '⚠ Faltou' : 'Sobrou'}</small><b class="num">${brl(Math.abs(left))}</b></div>
        </div>` : ''}
      </section>
      ${categoriesCard(cats, spent)}
      ${incomesCard(incs, income)}
      ${goalsCard()}
      ${list.length ? `
      <section class="card">
        <h2>Por forma de pagamento</h2>
        <ul class="list">
          ${Object.entries(byPay).sort((a, b) => b[1] - a[1]).map(([k, v]) => `
            <li class="item"><div class="grow title">${esc(k)}</div><div class="val num">${brl(v)}</div></li>`).join('')}
        </ul>
      </section>` : ''}`;
  }

  // ---------- Limites por categoria ----------
  const budgetOf = (cat) => { const b = state.budgets.find((x) => x.category === cat); return b ? Number(b.amount) : null; };

  function categoriesCard(cats, spent) {
    // Categorias com limite aparecem mesmo sem gasto no mês
    const extra = state.budgets.filter((b) => !cats.some(([c]) => c === b.category))
      .sort((a, b) => catIdx(a.category) - catIdx(b.category)).map((b) => [b.category, 0]);
    const rows = [...cats, ...extra];
    const max = cats.length ? cats[0][1] : 1;
    const body = rows.length
      ? `<div class="cat-list">${rows.map(([c, v]) => catRow(c, v, spent, max)).join('')}</div>`
      : '<p class="muted card-note">Nenhum gasto neste mês. Toque em + para lançar o primeiro.</p>';
    return `
      <section class="card">
        <div class="card-head"><h2>Categorias</h2><button class="btn small" id="budget-open">🎯 Limites</button></div>
        ${donut(cats, spent)}
        ${body}
      </section>`;
  }

  function catRow(c, v, spent, max) {
    const lim = budgetOf(c);
    let bar, note = '';
    if (lim) {
      const r = v / lim;
      const color = r > 1 ? 'var(--danger)' : r >= 0.8 ? 'var(--warn)' : catColor(c);
      bar = `<div class="cat-bar" style="--c:${color}"><i style="width:${Math.min(100, Math.max(2, r * 100))}%"></i></div>`;
      note = `<div class="cat-note${r > 1 ? ' over' : r >= 0.8 ? ' near' : ''}">${brl(v)} de ${brl(lim)} · ${r > 1 ? `passou ${brl(round2(v - lim))}` : `faltam ${brl(round2(lim - v))}`}</div>`;
    } else {
      bar = `<div class="cat-bar" style="--c:${catColor(c)}"><i style="width:${Math.max(2, (v / max) * 100)}%"></i></div>`;
    }
    return `
      <button type="button" class="cat-row" data-budget-cat="${esc(c)}">
        <div class="cat-top"><span><span class="muted">${pctLabel(v, spent)}</span> ${CAT_ICON[c] || '📦'} ${esc(c)}</span><b class="num">${brl(v)}</b></div>
        ${bar}${note}<span class="sr-only">Toque para definir o limite</span>
      </button>`;
  }

  function openBudgetForm(focusCat) {
    openSheet(`
      <h3>Limites por categoria</h3>
      <p class="muted sheet-note">Quanto você quer gastar por mês em cada categoria. Deixe em branco para não ter limite. Vale para todos os meses${state.profiles.length ? ` do perfil ${esc(profileName(activeProfile()))}` : ''}.</p>
      <form id="budget-form" novalidate>
        <div class="budget-grid">${CATEGORIES.map(([c, i]) => {
          const lim = budgetOf(c);
          return `<label class="budget-line"><span>${i} ${c}</span>
            <input data-cat="${c}" inputmode="decimal" placeholder="Sem limite" value="${lim ? moneyInput(lim) : ''}"></label>`;
        }).join('')}</div>
        <p class="msg error" id="budget-msg"></p>
        <div class="sheet-actions"><button class="btn primary" type="submit">Salvar limites</button></div>
      </form>`);
    const form = $('#budget-form');
    const target = focusCat && form.querySelector(`[data-cat="${CSS.escape(focusCat)}"]`);
    if (target) setTimeout(() => { target.focus(); target.scrollIntoView({ block: 'center' }); }, 60);

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = $('#budget-msg');
      const ops = [];
      for (const input of form.querySelectorAll('[data-cat]')) {
        const cat = input.dataset.cat, raw = input.value.trim();
        const v = raw ? parseMoney(raw) : null;
        if (raw && !(v > 0)) { msg.textContent = `Valor inválido em ${cat}.`; input.focus(); return; }
        const cur = state.budgets.find((b) => b.category === cat);
        if (!v && cur) ops.push(sb.from('budgets').delete().eq('id', cur.id));
        else if (v && cur && Number(cur.amount) !== v) {
          // se a linha sumiu (apagada em outro aparelho), o update não altera nada: trata como conflito
          ops.push(sb.from('budgets').update({ amount: v }).eq('id', cur.id).select()
            .then((r) => (r.error || r.data?.length ? r : { error: { message: 'duplicate key' } })));
        }
        else if (v && !cur) ops.push(sb.from('budgets').insert(withProfile({ category: cat, amount: v })));
      }
      if (!ops.length) { closeSheet(); return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      const res = await Promise.all(ops);
      const fresh = await optional('budgets'); // relê do banco (mesmo se algo falhou, a tela mostra o que ficou salvo)
      if (fresh) state.budgets = fresh;
      btn.disabled = false;
      const err = res.find((r) => r.error);
      if (err) {
        msg.textContent = /duplicate key/i.test(err.error.message)
          ? 'Os limites mudaram em outro aparelho. A lista foi atualizada: confira e salve de novo.'
          : /does not exist|schema cache/i.test(err.error.message) ? 'Limites indisponíveis no momento. Tente mais tarde.'
          : 'Erro ao salvar: ' + err.error.message;
        if (fresh) form.querySelectorAll('[data-cat]').forEach((i) => { const lim = budgetOf(i.dataset.cat); i.value = lim ? moneyInput(lim) : ''; });
        render();
        return;
      }
      closeSheet();
      render();
      toast('Limites salvos');
    };
  }

  // ---------- Próximos vencimentos (dentro do app) ----------
  function upcomingDues(days = 5) {
    const t = new Date();
    const out = [];
    for (const card of state.cards) {
      for (let off = 0; off <= days; off++) {
        const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + off);
        const idx = d.getFullYear() * 12 + d.getMonth();
        if (Math.min(card.due_day, daysIn(idx)) !== d.getDate()) continue;
        const inv = invoicesFor(idx).find((i) => i.card.id === card.id);
        if (inv && inv.total > 0) out.push({ card, off, idx, total: inv.total });
        break;
      }
    }
    return out.sort((a, b) => a.off - b.off);
  }

  function dueAlerts() {
    const dues = upcomingDues();
    if (!dues.length) return '';
    const when = (o) => (o === 0 ? 'vence hoje' : o === 1 ? 'vence amanhã' : `vence em ${o} dias`);
    return `
      <section class="card due-card">
        <h2>Próximos vencimentos</h2>
        <ul class="list">${dues.map((d) => `
          <li class="item">
            <span class="swatch" style="background:${safeColor(d.card.color)}"></span>
            <div class="grow"><div class="title">${esc(d.card.name)}</div>
              <div class="sub${d.off <= 1 ? ' urgent' : ''}">${when(d.off)} · ${dueDate(d.card, d.idx)}</div></div>
            <div class="val num">${brl(d.total)}</div>
          </li>`).join('')}
        </ul>
        ${state.push === 'off' ? '<button class="btn small" id="push-on-inline" style="margin-top:8px">🔔 Avisar no celular</button>' : ''}
      </section>`;
  }

  // ---------- Receitas (cartão no Resumo) ----------
  function incomesCard(incs, income) {
    const rows = incs.map((i) => `
      <li class="item tap" data-inc="${i.inc.id}">
        <div class="dot inc-dot">💰</div>
        <div class="grow"><div class="title">${esc(i.inc.description)}</div>
          <div class="sub">${i.inc.recurring ? `🔁 ${i.n ? `${i.inst}/${i.n}` : 'mensal'} · dia ${parseDate(i.inc.income_date).d}` : fmtDate(i.inc.income_date)}</div></div>
        <div class="val num pos">+ ${brl(i.amount)}</div>
      </li>`).join('');
    return `
      <section class="card">
        <div class="card-head"><h2>Receitas</h2><button class="btn small" id="income-add">+ Receita</button></div>
        ${incs.length ? `<ul class="list">${rows}</ul>${incs.length > 1 ? `<div class="invoice-total"><span>Total</span><span class="num">${brl(income)}</span></div>` : ''}`
          : '<p class="muted card-note">Lance seu salário e outras entradas para ver quanto sobra no mês.</p>'}
      </section>`;
  }

  // ---------- Metas (cartão no Resumo) ----------
  function goalInfo(g) {
    const left = round2(Math.max(0, Number(g.target) - Number(g.saved)));
    if (left <= 0) return '✅ Meta alcançada!';
    if (!g.deadline) return `faltam ${brl(left)}`;
    const { y, m } = parseDate(g.deadline);
    const months = y * 12 + m - curIdx() + 1; // conta o mês atual
    if (months <= 0) return `faltam ${brl(left)} · o prazo passou`;
    return `faltam ${brl(left)} · ${brl(Math.ceil((left / months) * 100) / 100)}/mês até ${shortMonth(y * 12 + m)}`;
  }

  function goalsCard() {
    const rows = state.goals.map((g) => {
      const p = Number(g.target) > 0 ? Number(g.saved) / Number(g.target) : 0;
      return `
        <button type="button" class="cat-row" data-goal="${g.id}">
          <div class="cat-top"><span>🎯 ${esc(g.name)}</span><b class="num">${p < 1 ? Math.floor(p * 100) : Math.round(p * 100)}%</b></div>
          <div class="cat-bar" style="--c:${safeColor(g.color)}"><i style="width:${Math.min(100, Math.max(2, p * 100))}%"></i></div>
          <div class="cat-note">${brl(Number(g.saved))} de ${brl(Number(g.target))} · ${goalInfo(g)}</div>
        </button>`;
    }).join('');
    return `
      <section class="card">
        <div class="card-head"><h2>Metas</h2><button class="btn small" id="goal-add">+ Meta</button></div>
        ${state.goals.length ? `<div class="cat-list">${rows}</div>`
          : '<p class="muted card-note">Crie uma meta (viagem, reserva de emergência…) e acompanhe quanto já guardou e quanto falta por mês.</p>'}
      </section>`;
  }

  const pct = (v, total) => (total > 0 ? Math.round((v / total) * 100) : 0);
  const pctLabel = (v, total) => { const p = pct(v, total); return v > 0 && p === 0 ? '<1%' : `${p}%`; };

  // Rosca por categoria: fatias com um pequeno espaço entre elas, % em cada fatia e o total no meio
  function donut(cats, total) {
    if (!(total > 0)) return '';
    const R = 80, W = 28, C = 2 * Math.PI * R, GAP = cats.length > 1 ? 3 : 0;
    const ink = isDarkTheme() ? CAT_DARK_INK_DARK : CAT_DARK_INK;
    let off = 0;
    const segs = cats.map(([c, v]) => {
      const len = (v / total) * C, i = catIdx(c);
      const mid = ((off + len / 2) / C) * 2 * Math.PI - Math.PI / 2;
      const p = pct(v, total);
      const seg = `
        <circle class="seg" cx="100" cy="100" r="${R}" stroke-width="${W}" style="stroke:var(--cat-${i})"
          stroke-dasharray="${Math.max(0.5, len - GAP).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
          transform="rotate(-90 100 100)"><title>${esc(c)}: ${brl(v)} (${p}%)</title></circle>
        ${p >= 6 ? `<text x="${(100 + R * Math.cos(mid)).toFixed(1)}" y="${(100 + R * Math.sin(mid)).toFixed(1)}" class="seg-lbl${ink.has(i) ? ' ink-dark' : ''}">${p}%</text>` : ''}`;
      off += len;
      return seg;
    }).join('');
    return `
      <div class="donut" role="img" aria-label="Gastos por categoria: ${cats.map(([c, v]) => `${esc(c)} ${pct(v, total)}%`).join(', ')}">
        <svg viewBox="0 0 200 200">${segs}</svg>
        <div class="donut-center"><small>Total</small><b class="num${brl(total).length >= 15 ? ' sm' : brl(total).length >= 12 ? ' md' : ''}">${brl(total)}</b></div>
      </div>`;
  }

  function entryRow(e) {
    const where = e.card ? esc(e.card.name) : 'Pix/boleto';
    const lbl = instLabel(e);
    const inst = lbl ? ` · ${e.exp.recurring ? '🔁 ' : ''}${lbl}` : '';
    return `
      <li class="item tap" data-exp="${e.exp.id}">
        <div class="dot" style="--c:${catColor(e.exp.category)}">${CAT_ICON[e.exp.category] || '📦'}</div>
        <div class="grow">
          <div class="title">${esc(e.exp.description)}</div>
          <div class="sub">${where}${inst} · ${e.exp.recurring ? 'dia ' + parseDate(e.exp.purchase_date).d : fmtDate(e.exp.purchase_date)}</div>
        </div>
        <div class="val num">${brl(e.mine)}</div>
      </li>`;
  }

  // Blocos do mês (usados na aba Gastos e no Excel): contas fixas, Pix/boleto/dinheiro e um por cartão
  function monthGroups(idx) {
    const list = entriesForMonth(idx).sort((a, b) => b.exp.purchase_date.localeCompare(a.exp.purchase_date));
    const sum = (items) => round2(items.reduce((s, e) => s + e.mine, 0));
    const groups = [];
    const fixas = list.filter((e) => !e.card && e.exp.recurring);
    const vista = list.filter((e) => !e.card && !e.exp.recurring);
    if (fixas.length) groups.push({ title: 'Contas fixas do mês', xlsTitle: 'CONTAS FIXAS', items: fixas, total: sum(fixas) });
    if (vista.length) groups.push({ title: 'Pix / boleto / dinheiro', xlsTitle: 'PIX / BOLETO / DINHEIRO', items: vista, total: sum(vista) });
    invoicesFor(idx).forEach((inv) => groups.push({
      card: inv.card, title: inv.card.name, items: inv.items, total: inv.total,
      xlsTitle: `CARTÃO ${inv.card.name.toUpperCase()} VENCIMENTO ${dueDate(inv.card, idx)}`,
    }));
    return groups;
  }

  function renderGastos() {
    const groups = monthGroups(state.month);
    const actions = `<div class="row-actions"><button class="btn small" id="check-invoice">🔍 Conferir fatura</button>${
      groups.length ? '<button class="btn primary small" id="export">⬇ Exportar Excel</button>' : ''}</div>`;
    if (!groups.length) return actions + emptyState('Nenhum gasto neste mês', 'Compras no cartão aparecem no mês da fatura.');
    const total = (v) => `<div class="invoice-total"><span>Total</span><span class="num">${brl(v)}</span></div>`;
    let html = actions;
    let cardsHead = false;
    for (const g of groups) {
      if (!g.card) {
        html += `<div class="day-head">${g.title}</div><section class="card"><ul class="list">${g.items.map(entryRow).join('')}</ul>${total(g.total)}</section>`;
        continue;
      }
      if (!cardsHead) { html += '<div class="day-head">Cartões (faturas deste mês)</div>'; cardsHead = true; }
      html += `
        <section class="card">
          <div class="invoice-head">
            <span class="swatch" style="background:${safeColor(g.card.color)}"></span>
            <h2>${esc(g.card.name)}</h2>
            <span class="muted">vence ${dueDate(g.card, state.month)}</span>
          </div>
          <ul class="list">${g.items.map(entryRow).join('')}</ul>${total(g.total)}
        </section>`;
    }
    html += `<section class="card sum-all"><span>Total do mês</span><span class="num">${brl(round2(groups.reduce((s, g) => s + g.total, 0)))}</span></section>`;
    return html;
  }

  function invoicesFor(idx) {
    const list = entriesForMonth(idx).filter((e) => e.card);
    return state.cards
      .map((card) => {
        const items = list.filter((e) => e.card.id === card.id).sort((a, b) => a.exp.purchase_date.localeCompare(b.exp.purchase_date));
        return { card, items, total: round2(items.reduce((s, e) => s + e.mine, 0)) };
      })
      .filter((inv) => inv.items.length);
  }

  function renderCartoes() {
    if (!state.cards.length) return emptyState('Nenhum cartão ainda', 'Toque em + para cadastrar (ex.: Nubank, fecha dia 3, vence dia 10).');
    return `
      <section class="card"><ul class="list">
        ${state.cards.map((c) => `
          <li class="item tap" data-card="${c.id}">
            <div class="dot" style="background:${safeColor(c.color)};color:#fff">▭</div>
            <div class="grow"><div class="title">${esc(c.name)}</div>
              <div class="sub">Fecha dia ${c.closing_day} · vence dia ${c.due_day}</div></div>
            <div class="val muted">›</div>
          </li>`).join('')}
      </ul></section>
      <p class="muted" style="text-align:center;font-size:13px">
        Compras feitas a partir do dia do fechamento entram na fatura seguinte.</p>`;
  }

  function emptyState(title, sub, extraHtml = '') {
    return `<div class="empty"><b>${esc(title)}</b>${esc(sub)}${extraHtml}</div>`;
  }

  // ---------- Menu ----------
  const ICON = {
    lock: '<path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="4" y="11" width="16" height="10" rx="2"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  };
  const svgIcon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  const profileIcon = (p) => (p ? (p.kind === 'empresa' ? '🏢' : '👤') : '⭐');
  const KIND_LABEL = { pessoa: 'Pessoa', empresa: 'Empresa' };

  function profileRows() {
    return [null, ...state.profiles].map((p) => {
      const id = p ? p.id : '';
      const on = (p ? p.id : null) === state.profileId;
      const av = p
        ? `<span class="avatar prof-av" style="background:${safeColor(p.color)};color:#fff">${esc(([...p.name][0] || '?').toUpperCase())}</span>`
        : '<span class="avatar prof-av" id="mini-avatar"></span>';
      return `<li class="prof-item${on ? ' on' : ''}">
          <button class="prof-pick" data-prof="${esc(id)}" aria-pressed="${on}">
            ${av}
            <span class="grow"><span class="title">${esc(profileName(p))}</span>
              <span class="sub">${p ? `${profileIcon(p)} ${KIND_LABEL[p.kind] || 'Pessoa'}` : '⭐ Perfil principal'}</span></span>
            ${on ? '<span class="prof-check" aria-label="ativo">✓</span>' : ''}
          </button>
          ${p ? `<button class="icon-btn prof-edit" data-prof-edit="${esc(id)}" aria-label="Editar ${esc(p.name)}">✎</button>` : ''}
        </li>`;
    }).join('');
  }

  function renderMenu() {
    const email = state.session?.user?.email || '';
    const theme = getTheme();
    const row = (inner, icon, label, cls = '') =>
      `${inner}<span class="mi">${svgIcon(icon)}</span><span class="grow">${label}</span><span class="chev" aria-hidden="true">›</span>`;
    const link = (href, icon, label) => `<a class="menu-row" href="${href}">${row('', icon, label)}</a>`;
    const btn = (id, icon, label, cls = '') => `<button class="menu-row ${cls}" id="${id}">${row('', icon, label)}</button>`;
    return `
      <section class="card">
        <div class="profile-head">
          <span class="avatar avatar-big" id="big-avatar"></span>
          <div class="avatar-edit">
            <button class="btn small" id="avatar-pick">📷 ${state.avatarUrl ? 'Trocar foto' : 'Adicionar foto'}</button>
            ${state.avatarUrl ? '<button class="btn small" id="avatar-remove">Remover</button>' : ''}
          </div>
          <input type="file" id="avatar-file" accept="image/*" hidden>
          <div class="muted" style="font-size:13px;margin-top:8px">Conectado como</div>
          <div class="profile-email">${esc(email)}</div>
        </div>
      </section>

      <section class="card">
        <h2>Perfis</h2>
        ${state.profilesOk ? `
          <ul class="list prof-list">${profileRows()}</ul>
          <button class="btn small" id="prof-add" style="margin-top:10px">+ Novo perfil</button>
          <p class="muted" style="font-size:12.5px;margin:10px 2px 0">Cada perfil tem os seus próprios cartões e gastos. Use para alguém da família ou para a sua empresa.</p>`
        : '<p class="muted" style="font-size:13.5px;margin:0">Perfis indisponíveis no momento.</p>'}
      </section>

      ${pushCard()}

      <section class="card">
        <h2>Tema do app</h2>
        <div class="seg" id="theme-seg">
          ${[['system', 'Automático'], ['light', '☀️ Claro'], ['dark', '🌙 Escuro']].map(([v, l]) =>
            `<button type="button" data-theme-opt="${v}" class="${v === theme ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        <p class="muted" style="font-size:12.5px;margin:8px 2px 0">Automático segue o tema do seu celular.</p>
      </section>

      <section class="card menu-list">
        ${btn('open-pwd', 'lock', 'Alterar senha')}
        ${link('termos.html', 'doc', 'Termos de uso')}
        ${link('privacidade.html', 'shield', 'Política de privacidade')}
      </section>

      <section class="card menu-list">
        ${btn('logout', 'out', 'Sair da conta')}
        ${btn('delete-account', 'trash', 'Excluir minha conta', 'danger')}
      </section>`;
  }

  // Lista de perfis em folha (aberta pelo seletor no topo)
  function openProfilePicker() {
    openSheet(`<h3>Trocar de perfil</h3><ul class="list prof-list">${profileRows()}</ul>`);
    paintAvatars();
    bindProfileRows($('#sheet'));
  }

  function bindProfileRows(root) {
    root.querySelectorAll('[data-prof]').forEach((b) => {
      b.onclick = () => { if (!$('#sheet').hidden) closeSheet(); switchProfile(b.dataset.prof || null); };
    });
    root.querySelectorAll('[data-prof-edit]').forEach((b) => {
      b.onclick = () => openProfileForm(state.profiles.find((p) => p.id === b.dataset.profEdit));
    });
  }

  function openProfileForm(prof) {
    const p = prof || { name: '', kind: 'pessoa', color: COLORS[(state.profiles.length + 2) % COLORS.length] };
    let color = p.color;
    openSheet(`
      <h3>${prof ? 'Editar perfil' : 'Novo perfil'}</h3>
      <form id="prof-form" novalidate>
        <label>Nome<input name="name" maxlength="30" value="${esc(p.name)}" placeholder="Ex.: Maria, Minha empresa" required></label>
        <div><label style="margin-bottom:6px">Tipo</label>${chipGroup('kind', [['pessoa', '👤 Pessoa'], ['empresa', '🏢 Empresa']], p.kind)}</div>
        <div><label style="margin-bottom:6px">Cor</label>
          <div class="color-row">${COLORS.map((c) =>
            `<button type="button" data-color="${c}" class="${c === color ? 'on' : ''}" style="background:${c}" aria-label="Cor ${c}"></button>`).join('')}</div></div>
        <p class="msg error" id="prof-msg"></p>
        <div class="sheet-actions">
          <button class="btn primary" type="submit">${prof ? 'Salvar' : 'Criar perfil'}</button>
          ${prof ? '<button class="btn danger" type="button" id="prof-del">Apagar perfil</button>' : ''}
        </div>
      </form>`);
    const form = $('#prof-form');
    bindChips(form);
    form.querySelectorAll('[data-color]').forEach((b) => {
      b.onclick = () => { color = b.dataset.color; form.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b)); };
    });
    if (!prof) setTimeout(() => form.name.focus(), 50);

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const row = { name: form.name.value.trim(), kind: chipVal(form, 'kind'), color };
      const msg = $('#prof-msg');
      if (!row.name) { msg.textContent = 'Informe o nome do perfil.'; return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true; // evita criar o mesmo perfil duas vezes com toque duplo
      const res = prof
        ? await sb.from('profiles').update(row).eq('id', prof.id).select().single()
        : await sb.from('profiles').insert(row).select().single();
      btn.disabled = false;
      if (res.error) { msg.textContent = 'Erro ao salvar: ' + res.error.message; return; }
      if (prof) state.profiles = state.profiles.map((x) => (x.id === prof.id ? res.data : x));
      else state.profiles.push(res.data);
      closeSheet();
      render();
      toast(prof ? 'Perfil atualizado' : `Perfil "${res.data.name}" criado. Toque nele para usar.`);
    };

    const del = $('#prof-del');
    if (del) del.onclick = async () => {
      if (!confirm(`Apagar o perfil "${prof.name}" com TODOS os cartões e gastos dele? Não dá para desfazer.`)) return;
      del.disabled = true;
      const { error } = await sb.from('profiles').delete().eq('id', prof.id);
      del.disabled = false;
      if (error) { toast('Erro ao apagar: ' + error.message); return; }
      state.profiles = state.profiles.filter((x) => x.id !== prof.id);
      closeSheet();
      if (state.profileId === prof.id) switchProfile(null);
      else render();
      toast(`Perfil "${prof.name}" apagado`);
    };
  }

  // Confere a senha atual sem mexer na sessão do app (cliente separado, que não guarda nada no aparelho).
  // Assim quem pega o celular desbloqueado não consegue trocar a senha nem excluir a conta.
  async function checkPassword(password) {
    const tmp = window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'sb-check-password' },
    });
    const { error } = await tmp.auth.signInWithPassword({ email: state.session.user.email, password });
    if (!error) await tmp.auth.signOut({ scope: 'local' }).catch(() => {});
    return error;
  }
  const passwordError = (e) => (/invalid login/i.test(e.message) ? 'Senha atual incorreta.' : 'Erro: ' + e.message);

  function openPasswordForm() {
    openSheet(`
      <h3>Alterar senha</h3>
      <form id="pwd-form" novalidate>
        <label>Senha atual<input type="password" name="p0" autocomplete="current-password" required></label>
        <label>Nova senha<input type="password" name="p1" minlength="8" autocomplete="new-password" required></label>
        <label>Repita a nova senha<input type="password" name="p2" minlength="8" autocomplete="new-password" required></label>
        <p class="msg error" id="pwd-msg"></p>
        <div class="sheet-actions"><button class="btn primary" type="submit">Salvar nova senha</button></div>
      </form>`);
    const f = $('#pwd-form');
    setTimeout(() => f.p0.focus(), 50);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = $('#pwd-msg');
      if (!f.p0.value) { msg.textContent = 'Digite a senha atual.'; return; }
      if (f.p1.value.length < 8 || !/[a-z]/i.test(f.p1.value) || !/\d/.test(f.p1.value)) {
        msg.textContent = 'A nova senha precisa ter pelo menos 8 caracteres, com letras e números.'; return;
      }
      if (f.p1.value !== f.p2.value) { msg.textContent = 'As senhas não são iguais.'; return; }
      const btn = f.querySelector('[type=submit]');
      btn.disabled = true;
      const bad = await checkPassword(f.p0.value);
      if (bad) { btn.disabled = false; msg.textContent = passwordError(bad); return; }
      const { error } = await sb.auth.updateUser({ password: f.p1.value });
      btn.disabled = false;
      if (error) {
        msg.textContent = /different from the old/i.test(error.message) ? 'A nova senha precisa ser diferente da atual.' : 'Erro: ' + error.message;
        return;
      }
      closeSheet();
      toast('Senha alterada com sucesso');
    };
  }

  // Excluir a conta (exigência da Play Store): apaga a foto e depois o usuário;
  // o banco apaga perfis, cartões e gastos junto (ON DELETE CASCADE)
  async function deleteAccount() {
    if (!confirm('Excluir sua conta? Todos os perfis, cartões e gastos serão apagados para sempre.')) return;
    const typed = prompt('Para confirmar, digite EXCLUIR');
    if ((typed || '').trim().toUpperCase() !== 'EXCLUIR') { toast('Exclusão cancelada'); return; }
    openSheet(`
      <h3>Excluir conta</h3>
      <p class="muted sheet-note">Digite sua senha para confirmar. Depois disso não dá para desfazer.</p>
      <form id="del-form" novalidate>
        <label>Senha<input type="password" name="pw" autocomplete="current-password" required></label>
        <p class="msg error" id="del-msg"></p>
        <div class="sheet-actions"><button class="btn danger" type="submit">Excluir minha conta</button></div>
      </form>`);
    const f = $('#del-form');
    setTimeout(() => f.pw.focus(), 50);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = $('#del-msg'), btn = f.querySelector('[type=submit]');
      if (!f.pw.value) { msg.textContent = 'Digite sua senha.'; return; }
      btn.disabled = true;
      const bad = await checkPassword(f.pw.value);
      if (bad) { btn.disabled = false; msg.textContent = passwordError(bad); return; }
      // A foto precisa sair antes (o banco não consegue apagar arquivos). Se falhar, não exclui: senão ela ficaria para sempre.
      const rm = await sb.storage.from('avatars').remove([avatarPath()]);
      if (rm.error) { btn.disabled = false; msg.textContent = 'Erro ao apagar a foto: ' + rm.error.message; return; }
      const done = await finishDeleteAccount();
      if (!done) btn.disabled = false;
    };
  }

  async function finishDeleteAccount() {
    const { error } = await sb.rpc('delete_my_account');
    if (error) { toast('Erro ao excluir: ' + error.message); return false; }
    try { localStorage.removeItem(profileKey()); } catch {}
    closeSheet();
    await signOutSafe();
    toast('Conta excluída');
    return true;
  }

  // Sair: encerra a sessão no servidor (todos os aparelhos). Sem internet o supabase-js devolve erro e NÃO apaga
  // a sessão (nem com scope 'local', que também chama o servidor): então apaga a sessão guardada aqui e recarrega.
  async function signOutSafe() {
    const r = await sb.auth.signOut().catch((e) => ({ error: e }));
    if (!r?.error) return null;
    try { localStorage.removeItem(sb.auth.storageKey); } catch {}
    try { sessionStorage.setItem('signedOutOffline', '1'); } catch {}
    location.reload();
    return r.error;
  }

  // Tema: 'system' | 'light' | 'dark' (preferência deste aparelho)
  function getTheme() {
    try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; }
  }
  function applyTheme(t) {
    try { t === 'system' ? localStorage.removeItem('theme') : localStorage.setItem('theme', t); } catch {}
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name="theme-color"]').content = dark ? '#0f1115' : '#f4f5f7';
  }

  // Foto de perfil (guardada no Supabase Storage, pasta privada do usuário)
  const avatarPath = () => `${state.session.user.id}/avatar.jpg`;

  let avatarAt = 0; // quando o link assinado da foto foi gerado
  async function loadAvatar() {
    avatarAt = Date.now();
    const { data, error } = await sb.storage.from('avatars').createSignedUrl(avatarPath(), 60 * 60); // 1 h: o app gera outro link a cada abertura
    state.avatarUrl = error ? null : data.signedUrl;
    paintAvatars();
    if (state.tab === 'menu') render();
  }

  function paintAvatars() {
    const initial = (state.session?.user?.email || '?')[0].toUpperCase();
    document.querySelectorAll('#big-avatar, #mini-avatar').forEach((el) => {
      if (state.avatarUrl) { el.style.backgroundImage = `url("${state.avatarUrl}")`; el.textContent = ''; }
      else { el.style.backgroundImage = ''; el.textContent = initial; }
    });
  }

  // Reduz a foto para 256x256 (recorte quadrado central) antes de enviar
  function resizeImage(file, size = 256) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(img.src);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('Não foi possível processar a imagem'))), 'image/jpeg', 0.85);
      };
      img.onerror = () => reject(new Error('Arquivo de imagem inválido'));
      img.src = URL.createObjectURL(file);
    });
  }

  async function uploadAvatar(file) {
    const btn = $('#avatar-pick');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const blob = await resizeImage(file);
      const { error } = await sb.storage.from('avatars').upload(avatarPath(), blob, { upsert: true, contentType: 'image/jpeg', cacheControl: '60' });
      if (error) throw error;
      await loadAvatar();
      toast('Foto atualizada');
    } catch (err) {
      toast('Erro ao enviar foto: ' + err.message);
      render();
    }
  }

  async function removeAvatar() {
    if (!confirm('Remover sua foto de perfil?')) return;
    const { error } = await sb.storage.from('avatars').remove([avatarPath()]);
    if (error) { toast('Erro ao remover: ' + error.message); return; }
    state.avatarUrl = null;
    render();
    toast('Foto removida');
  }

  function bindMenu() {
    const pick = $('#avatar-pick');
    if (!pick) return;
    const file = $('#avatar-file');
    pick.onclick = () => file.click();
    file.onchange = () => { if (file.files[0]) uploadAvatar(file.files[0]); };
    const rm = $('#avatar-remove'); if (rm) rm.onclick = removeAvatar;

    document.querySelectorAll('[data-theme-opt]').forEach((b) => {
      b.onclick = () => {
        applyTheme(b.dataset.themeOpt);
        document.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('on', x === b));
      };
    });

    bindProfileRows($('#view'));
    const add = $('#prof-add'); if (add) add.onclick = () => openProfileForm();
    $('#open-pwd').onclick = openPasswordForm;
    $('#delete-account').onclick = deleteAccount;
  }

  function bindView() {
    document.querySelectorAll('[data-exp]').forEach((el) => {
      el.onclick = () => openExpenseForm(state.expenses.find((x) => x.id === el.dataset.exp));
    });
    document.querySelectorAll('[data-card]').forEach((el) => {
      el.onclick = () => openCardForm(state.cards.find((x) => x.id === el.dataset.card));
    });
    const ex = $('#export'); if (ex) ex.onclick = exportExcel;
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    on('#check-invoice', openInvoiceCheck);
    on('#budget-open', () => openBudgetForm());
    on('#income-add', () => openIncomeForm());
    on('#goal-add', () => openGoalForm());
    on('#push-on', enablePush);
    on('#push-on-inline', enablePush);
    on('#push-off', disablePush);
    on('#push-test', async () => {
      const { data, error } = await sb.functions.invoke('due-reminders', { body: { action: 'test' } });
      toast(error ? 'Erro ao enviar: ' + error.message : data?.sent ? 'Teste enviado. Confira as notificações.' : 'Nenhum celular inscrito. Desative e ative de novo.');
    });
    document.querySelectorAll('[data-budget-cat]').forEach((el) => { el.onclick = () => openBudgetForm(el.dataset.budgetCat); });
    document.querySelectorAll('[data-inc]').forEach((el) => {
      el.onclick = () => openIncomeForm(state.incomes.find((x) => x.id === el.dataset.inc));
    });
    document.querySelectorAll('[data-goal]').forEach((el) => {
      el.onclick = () => openGoalForm(state.goals.find((x) => x.id === el.dataset.goal));
    });
    const rt = $('#retry'); if (rt) rt.onclick = () => { state.loadError = false; render(); loadData(); };
    const lo = $('#logout'); if (lo) lo.onclick = async () => { if (confirm('Sair da conta?')) {
      await unlinkPush();
      await signOutSafe();
    } };
    bindMenu();
  }

  // ---------- Folha inferior ----------
  let sheetSeq = 0; // muda a cada folha aberta (conteúdo que chega atrasado confere se ainda é a mesma folha)
  function openSheet(html) {
    sheetSeq++;
    const sh = $('#sheet');
    sh.innerHTML = `<div class="grip"></div>${html}`;
    sh.hidden = false;
    $('#sheet-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    loadSeq++; // descarta atualização em andamento (não pode sobrescrever o que for salvo aqui)
    if (!nav.sheetPushed) {
      // um "voltar" ainda em andamento (folha fechada agora há pouco) desfaria esta entrada: empilha depois dele
      if (nav.ignorePop > 0) nav.pushAfterPop = true; else history.pushState({ sheet: true }, '');
      nav.sheetPushed = true;
    }
    $('#sheet').oninput = () => { const m = $('#sheet').querySelector('.msg.error'); if (m) m.textContent = ''; }; // corrigiu o campo: some o erro
  }
  function closeSheet(fromPop = false) {
    if (!fromPop && nav.sheetPushed) {
      nav.sheetPushed = false;
      if (nav.pushAfterPop) nav.pushAfterPop = false; else historyBack();
    }
    $('#sheet').hidden = true;
    $('#sheet-backdrop').hidden = true;
    document.body.style.overflow = '';
  }
  $('#sheet-backdrop').onclick = () => closeSheet();

  // Termos e Política abrem numa folha dentro do app (assim a seta "voltar" do
  // celular fecha a folha em vez de sair do app). Vale para qualquer link a eles.
  async function openLegal(href) {
    const [file, hash] = href.split('#');
    openSheet('<p class="muted" style="text-align:center;padding:24px 0">Carregando…</p>');
    const mine = sheetSeq;
    let html = '';
    try {
      const res = await fetch(file);
      if (!res.ok) throw new Error(res.status);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const title = doc.querySelector('h1')?.textContent || '';
      const updated = doc.querySelector('.updated')?.textContent || '';
      const body = doc.querySelector('article')?.innerHTML || '';
      html = `<div class="legal-sheet"><h3>${esc(title)}</h3><p class="muted legal-upd">${esc(updated)}</p>${body}
        <div class="sheet-actions"><button class="btn" type="button" id="legal-close">Fechar</button></div></div>`;
    } catch {
      html = '<p class="msg error">Não foi possível abrir agora. Verifique a internet e tente de novo.</p>';
    }
    if ($('#sheet').hidden || sheetSeq !== mine) return; // fechou ou abriu outra folha enquanto carregava
    $('#sheet').innerHTML = `<div class="grip"></div>${html}`;
    $('#sheet').scrollTop = 0;
    const close = $('#legal-close');
    if (close) close.onclick = () => closeSheet();
    if (hash) $('#sheet').querySelector('#' + CSS.escape(hash))?.scrollIntoView();
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!/^(termos|privacidade)\.html(#[\w-]+)?$/.test(href)) return;
    e.preventDefault();
    openLegal(href);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  function chipGroup(name, options, current) {
    return `<div class="chips" data-group="${name}">${options.map(([v, label]) =>
      `<button type="button" class="chip${String(v) === String(current) ? ' on' : ''}" aria-pressed="${String(v) === String(current)}" data-v="${esc(v)}">${label}</button>`).join('')}</div>`;
  }
  function bindChips(root, onChange) {
    root.querySelectorAll('[data-group]').forEach((g) => {
      g.querySelectorAll('.chip').forEach((c) => {
        c.onclick = () => {
          g.querySelectorAll('.chip').forEach((x) => { x.classList.toggle('on', x === c); x.setAttribute('aria-pressed', String(x === c)); });
          onChange && onChange();
        };
      });
    });
  }
  const chipVal = (root, name) => root.querySelector(`[data-group="${name}"] .chip.on`)?.dataset.v;

  // ---------- Formulário de gasto ----------
  // Tipos: 'single' (única) | 'installment' (parcelada, valor total dividido) | 'recurring' (mensal fixa: valor cheio todo mês)
  function openExpenseForm(exp) {
    const e = exp || { description: '', category: 'Mercado', purchase_date: todayStr(), card_id: '', installments: 1, split_divisor: 1, recurring: false, recur_count: null };
    const kind = e.recurring ? 'recurring' : e.installments > 1 ? 'installment' : 'single';
    const payOpts = [['', '💵 Pix / boleto'], ...state.cards.map((c) => [c.id, `▭ ${esc(c.name)}`])];
    const card0 = cardById(e.card_id);
    const canEnd = exp && exp.recurring && state.month >= startMonth(exp, card0);
    // Conta fixa aberta num mês depois do 1º: mudar valor, cartão ou divisão vale a partir deste mês
    const fromIdx = exp && exp.recurring && state.month > startMonth(exp, card0) ? state.month : null;
    const cur = exp && exp.recurring ? valuesAt(exp, Math.max(state.month, startMonth(exp, card0))) : moneyOf(e); // valores do mês na tela
    openSheet(`
      <h3>${exp ? 'Editar gasto' : 'Novo gasto'}</h3>
      <form id="exp-form" novalidate>
        <div><label style="margin-bottom:6px">Tipo</label>${chipGroup('kind', [['single', 'Única'], ['installment', 'Parcelada'], ['recurring', '🔁 Mensal fixa']], kind)}</div>
        <label><span id="amount-label">Valor total da compra</span>
          <input class="amount-input num" name="amount" inputmode="decimal" placeholder="0,00" required
            value="${exp ? cur.amount.toFixed(2).replace('.', ',') : ''}"></label>
        <label>Descrição<input name="description" maxlength="80" required placeholder="Ex.: Mercado, Internet, Financiamento" value="${esc(e.description)}"></label>
        <div><label style="margin-bottom:6px">Categoria</label>${chipGroup('category', CATEGORIES.map(([c, i]) => [c, `${i} ${c}`]), e.category)}</div>
        <div><label style="margin-bottom:6px">Pagamento</label>${chipGroup('card', payOpts, cardById(cur.card_id) ? cur.card_id : '')}</div>
        <div class="grid2">
          <label><span id="date-label">Data da compra</span><input type="date" name="purchase_date" required value="${e.purchase_date}"></label>
          <label id="inst-wrap">Parcelas
            <select name="installments">${Array.from({ length: 47 }, (_, i) => i + 2).map((n) =>
              `<option value="${n}"${n === e.installments ? ' selected' : ''}>${n}x</option>`).join('')}</select></label>
          <label id="recur-wrap">Por quantos meses?
            <input name="recur_count" type="number" min="1" max="600" inputmode="numeric" placeholder="Sem fim" value="${e.recur_count || ''}"></label>
        </div>
        <div class="preview" id="exp-preview"></div>
        <p class="msg error" id="exp-msg"></p>
        <div class="sheet-actions">
          <button class="btn primary" type="submit">${exp ? 'Salvar alterações' : 'Adicionar gasto'}</button>
          ${canEnd ? `<button class="btn" type="button" id="exp-end">⏹ Encerrar após ${monthName(state.month)}</button>` : ''}
          ${exp ? '<button class="btn danger" type="button" id="exp-del">Excluir gasto</button>' : ''}
        </div>
      </form>`);

    const form = $('#exp-form');
    // Lê o formulário no formato da tabela
    const readRow = () => {
      const k = chipVal(form, 'kind');
      const rc = parseInt(form.recur_count.value, 10);
      return {
        description: form.description.value.trim(),
        amount: parseMoney(form.amount.value),
        category: chipVal(form, 'category') || 'Outros',
        purchase_date: form.purchase_date.value,
        card_id: chipVal(form, 'card') || null,
        installments: k === 'installment' ? Number(form.installments.value) : 1,
        recurring: k === 'recurring',
        recur_count: k === 'recurring' && rc > 0 ? Math.min(rc, 600) : null,
        split_divisor: 1, // divisão entre pessoas foi removida do app (2026-11-20)
      };
    };
    const isForward = (row) => fromIdx !== null && row.recurring && !sameMoney(moneyOf(row), valuesAt(exp, fromIdx));

    const update = () => {
      const row = readRow();
      const k = chipVal(form, 'kind');
      const card = cardById(row.card_id);
      $('#inst-wrap').hidden = k !== 'installment';
      $('#recur-wrap').hidden = k !== 'recurring';
      $('#amount-label').textContent = k === 'recurring' ? 'Valor por mês' : 'Valor total da compra';
      $('#date-label').textContent = k === 'recurring' ? 'Primeiro mês (data)' : 'Data da compra';
      const { amount } = row;
      const pv = $('#exp-preview');
      if (!(amount > 0)) { pv.textContent = 'Digite o valor para ver o resumo.'; return; }
      const start = row.purchase_date ? startMonth(row, card) : null;
      let txt;
      if (k === 'recurring') {
        const n = row.recur_count;
        txt = `${brl(amount)} todo mês`;
        if (isForward(row)) txt += ` · vale a partir de ${monthName(fromIdx)} (os meses anteriores não mudam)`;
        else if (start !== null) txt += n ? ` · de ${monthName(start)} até ${monthName(start + n - 1)} (${n}x)` : ` · a partir de ${monthName(start)}, sem data para acabar`;
      } else if (k === 'installment') {
        const n = row.installments;
        const per = round2(amount / n), lastP = round2(amount - per * (n - 1));
        txt = lastP === per ? `${n}x de ${brl(per)}` : `${n - 1}x de ${brl(per)} + 1x de ${brl(lastP)}`;
        if (start !== null) txt += ` · de ${monthName(start)} até ${monthName(start + n - 1)}`;
      } else {
        txt = brl(amount);
        if (card && start !== null) txt += ` · entra na fatura de ${monthName(start)}`;
      }
      pv.textContent = txt;
    };
    bindChips(form, update);
    form.addEventListener('input', update);
    update();
    if (!exp) setTimeout(() => form.amount.focus(), 50);

    async function save(row) {
      const msg = $('#exp-msg');
      const res = exp
        ? await sb.from('expenses').update(row).eq('id', exp.id).select().single()
        : await sb.from('expenses').insert(withProfile(row)).select().single();
      if (res.error) { msg.textContent = 'Erro ao salvar: ' + res.error.message; return false; }
      if (exp) state.expenses = state.expenses.map((x) => (x.id === exp.id ? res.data : x));
      else state.expenses.unshift(res.data);
      closeSheet();
      render();
      return true;
    }

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const row = readRow();
      const msg = $('#exp-msg');
      if (!(row.amount > 0)) { msg.textContent = 'Informe um valor válido.'; return; }
      if (!row.description) { msg.textContent = 'Informe uma descrição.'; return; }
      if (!row.purchase_date) { msg.textContent = 'Informe a data.'; return; }
      if (row.recurring && !validMonths(form.recur_count.value)) { msg.textContent = 'Meses: use um número inteiro de 1 a 600, ou deixe em branco para sem fim.'; return; }
      const forward = isForward(row);
      // Conta fixa continua conta fixa: valor/cartão/divisão novos valem a partir do mês na tela
      const data = exp && exp.recurring && row.recurring
        ? mergeForward(exp, row, Math.max(state.month, startMonth(exp, card0)))
        : { ...row, recur_changes: [] };
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      const ok = await save(data);
      btn.disabled = false;
      if (ok) toast(forward ? `Alterado a partir de ${monthName(fromIdx)}` : exp ? 'Gasto atualizado' : 'Gasto adicionado');
    };

    const end = $('#exp-end');
    if (end) end.onclick = async () => {
      const count = state.month - startMonth(exp, card0) + 1;
      if (!confirm(`Encerrar "${exp.description}"? Ele aparece até ${monthName(state.month)} e some dos meses seguintes.`)) return;
      if (await save({ recur_count: count })) toast('Conta encerrada');
    };

    const del = $('#exp-del');
    if (del) del.onclick = async () => {
      const extra = exp.recurring ? ' de todos os meses (inclusive os anteriores)' : exp.installments > 1 ? ' e todas as parcelas' : '';
      if (!confirm(`Excluir "${exp.description}"${extra}?${exp.recurring ? '\n\nSe você só cancelou a conta, use "Encerrar" para manter o histórico.' : ''}`)) return;
      const { error } = await sb.from('expenses').delete().eq('id', exp.id);
      if (error) { $('#exp-msg').textContent = 'Erro ao excluir: ' + error.message; return; }
      state.expenses = state.expenses.filter((x) => x.id !== exp.id);
      closeSheet();
      render();
      toast('Gasto excluído');
    };
  }

  // ---------- Formulário de receita ----------
  function openIncomeForm(inc) {
    const i = inc || { description: '', income_date: todayStr(), recurring: true, recur_count: null };
    const start0 = inc ? incStart(inc) : null;
    const canEnd = inc && inc.recurring && state.month >= start0;
    const fromIdx = inc && inc.recurring && state.month > start0 ? state.month : null; // valor novo vale a partir deste mês
    const curAmount = inc ? (inc.recurring ? incAmountAt(inc, Math.max(state.month, start0)) : Number(inc.amount)) : null;
    openSheet(`
      <h3>${inc ? 'Editar receita' : 'Nova receita'}</h3>
      <form id="inc-form" novalidate>
        <div><label style="margin-bottom:6px">Tipo</label>${chipGroup('kind', [['recurring', '🔁 Todo mês'], ['single', 'Única']], i.recurring ? 'recurring' : 'single')}</div>
        <label><span id="inc-amount-label">Valor</span>
          <input class="amount-input num" name="amount" inputmode="decimal" placeholder="0,00" required value="${inc ? moneyInput(curAmount) : ''}"></label>
        <label>Descrição<input name="description" maxlength="80" required placeholder="Ex.: Salário, Freela, Aluguel recebido" value="${esc(i.description)}"></label>
        <div class="grid2">
          <label><span id="inc-date-label">Data</span><input type="date" name="income_date" required value="${i.income_date}"></label>
          <label id="inc-recur-wrap">Por quantos meses?
            <input name="recur_count" type="number" min="1" max="600" inputmode="numeric" placeholder="Sem fim" value="${i.recur_count || ''}"></label>
        </div>
        <div class="preview" id="inc-preview"></div>
        <p class="msg error" id="inc-msg"></p>
        <div class="sheet-actions">
          <button class="btn primary" type="submit">${inc ? 'Salvar alterações' : 'Adicionar receita'}</button>
          ${canEnd ? `<button class="btn" type="button" id="inc-end">⏹ Encerrar após ${monthName(state.month)}</button>` : ''}
          ${inc ? '<button class="btn danger" type="button" id="inc-del">Excluir receita</button>' : ''}
        </div>
      </form>`);
    const form = $('#inc-form');
    const readRow = () => {
      const rec = chipVal(form, 'kind') === 'recurring';
      const rc = parseInt(form.recur_count.value, 10);
      return {
        description: form.description.value.trim(),
        amount: parseMoney(form.amount.value),
        income_date: form.income_date.value,
        recurring: rec,
        recur_count: rec && rc > 0 ? Math.min(rc, 600) : null,
      };
    };
    const isForward = (row) => fromIdx !== null && row.recurring && row.amount !== incAmountAt(inc, fromIdx);
    const update = () => {
      const row = readRow();
      $('#inc-recur-wrap').hidden = !row.recurring;
      const endBtn = $('#inc-end'); if (endBtn) endBtn.hidden = !row.recurring;
      $('#inc-amount-label').textContent = row.recurring ? 'Valor por mês' : 'Valor';
      $('#inc-date-label').textContent = row.recurring ? 'Primeiro mês (data)' : 'Data';
      const pv = $('#inc-preview');
      if (!(row.amount > 0)) { pv.textContent = 'Digite o valor para ver o resumo.'; return; }
      if (!row.income_date) { pv.textContent = brl(row.amount); return; }
      const st = incStart(row);
      let txt = row.recurring ? `${brl(row.amount)} todo mês` : `${brl(row.amount)} em ${monthName(st)}`;
      if (isForward(row)) txt += ` · vale a partir de ${monthName(fromIdx)} (os meses anteriores não mudam)`;
      else if (row.recurring) txt += row.recur_count ? ` · de ${monthName(st)} até ${monthName(st + row.recur_count - 1)}` : ` · a partir de ${monthName(st)}, sem data para acabar`;
      pv.textContent = txt;
    };
    bindChips(form, update);
    form.addEventListener('input', update);
    update();
    if (!inc) setTimeout(() => form.amount.focus(), 50);

    async function save(data) {
      const res = inc
        ? await sb.from('incomes').update(data).eq('id', inc.id).select().single()
        : await sb.from('incomes').insert(withProfile(data)).select().single();
      if (res.error) { $('#inc-msg').textContent = 'Erro ao salvar: ' + res.error.message; return false; }
      if (inc) state.incomes = state.incomes.map((x) => (x.id === inc.id ? res.data : x));
      else state.incomes.push(res.data);
      closeSheet();
      render();
      return true;
    }

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const row = readRow();
      const msg = $('#inc-msg');
      if (!(row.amount > 0)) { msg.textContent = 'Informe um valor válido.'; return; }
      if (!row.description) { msg.textContent = 'Informe uma descrição.'; return; }
      if (!row.income_date) { msg.textContent = 'Informe a data.'; return; }
      if (row.recurring && !validMonths(form.recur_count.value)) { msg.textContent = 'Meses: use um número inteiro de 1 a 600, ou deixe em branco para sem fim.'; return; }
      const forward = inc && isForward(row);
      const data = inc ? incomeForward(inc, row, Math.max(state.month, start0)) : { ...row, recur_changes: [] };
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      const ok = await save(data);
      btn.disabled = false;
      if (ok) toast(forward ? `Alterado a partir de ${monthName(fromIdx)}` : inc ? 'Receita atualizada' : 'Receita adicionada');
    };

    const end = $('#inc-end');
    if (end) end.onclick = async () => {
      if (!confirm(`Encerrar "${inc.description}"? Ela aparece até ${monthName(state.month)} e some dos meses seguintes.`)) return;
      if (await save({ recur_count: state.month - start0 + 1 })) toast('Receita encerrada');
    };
    const del = $('#inc-del');
    if (del) del.onclick = async () => {
      if (!confirm(`Excluir "${inc.description}"${inc.recurring ? ' de todos os meses (inclusive os anteriores)' : ''}?${inc.recurring ? '\n\nSe ela só acabou, use "Encerrar" para manter o histórico.' : ''}`)) return;
      const { error } = await sb.from('incomes').delete().eq('id', inc.id);
      if (error) { $('#inc-msg').textContent = 'Erro ao excluir: ' + error.message; return; }
      state.incomes = state.incomes.filter((x) => x.id !== inc.id);
      closeSheet();
      render();
      toast('Receita excluída');
    };
  }

  // ---------- Formulário de meta ----------
  function openGoalForm(goal) {
    const AUTO = COLORS.filter((c) => c !== '#111827'); // cor automática: sem o quase-preto (some no tema escuro)
    const g = goal || { name: '', target: '', saved: 0, deadline: null, color: AUTO[(state.goals.length + 2) % AUTO.length] };
    let color = g.color;
    openSheet(`
      <h3>${goal ? esc(goal.name) : 'Nova meta'}</h3>
      ${goal ? `
      <div class="goal-move">
        <div class="goal-move-top"><span class="muted">Guardado</span><b class="num">${brl(Number(goal.saved))} <span class="muted">de ${brl(Number(goal.target))}</span></b></div>
        <div class="goal-move-row">
          <input id="goal-move-val" inputmode="decimal" placeholder="Valor">
          <button class="btn primary small" type="button" id="goal-in">+ Guardar</button>
          <button class="btn small" type="button" id="goal-out">− Retirar</button>
        </div>
      </div>` : ''}
      <form id="goal-form" novalidate>
        <label>Nome<input name="name" maxlength="40" required placeholder="Ex.: Viagem, Reserva de emergência" value="${esc(g.name)}"></label>
        <div class="grid2">
          <label>Valor da meta<input name="target" inputmode="decimal" required placeholder="0,00" value="${g.target ? moneyInput(g.target) : ''}"></label>
          ${goal ? '' : '<label>Já guardado<input name="saved" inputmode="decimal" placeholder="0,00"></label>'}
          <label>Prazo (opcional)<input type="month" name="deadline" value="${g.deadline ? g.deadline.slice(0, 7) : ''}"></label>
        </div>
        <div><label style="margin-bottom:6px">Cor</label>
          <div class="color-row">${COLORS.map((c) =>
            `<button type="button" data-color="${c}" class="${c === color ? 'on' : ''}" style="background:${c}" aria-label="Cor ${c}"></button>`).join('')}</div></div>
        <div class="preview" id="goal-preview"></div>
        <p class="msg error" id="goal-msg"></p>
        <div class="sheet-actions">
          <button class="btn primary" type="submit">${goal ? 'Salvar alterações' : 'Criar meta'}</button>
          ${goal ? '<button class="btn danger" type="button" id="goal-del">Apagar meta</button>' : ''}
        </div>
      </form>`);
    const form = $('#goal-form');
    form.querySelectorAll('[data-color]').forEach((b) => {
      b.onclick = () => { color = b.dataset.color; form.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b)); };
    });
    const readRow = () => ({
      name: form.name.value.trim(),
      target: parseMoney(form.target.value),
      deadline: form.deadline.value ? `${form.deadline.value}-01` : null,
      ...(goal ? {} : { saved: form.saved.value.trim() ? parseMoney(form.saved.value) : 0 }),
    });
    const update = () => {
      const row = readRow();
      const pv = $('#goal-preview');
      if (!(row.target > 0)) { pv.textContent = 'Digite o valor da meta para ver quanto guardar por mês.'; return; }
      if (!goal && !(row.saved >= 0)) { pv.textContent = 'O valor já guardado está inválido.'; return; }
      pv.textContent = goalInfo({ ...row, saved: goal ? goal.saved : row.saved || 0 }).replace(/^faltam/, 'Faltam');
    };
    form.addEventListener('input', update);
    update();
    if (!goal) setTimeout(() => form.name.focus(), 50);

    async function save(data, okMsg) {
      const res = goal
        ? await sb.from('goals').update(data).eq('id', goal.id).select().single()
        : await sb.from('goals').insert(withProfile(data)).select().single();
      if (res.error) { $('#goal-msg').textContent = 'Erro ao salvar: ' + res.error.message; return; }
      if (goal) state.goals = state.goals.map((x) => (x.id === goal.id ? res.data : x));
      else state.goals.push(res.data);
      closeSheet();
      render();
      toast(okMsg);
    }

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const row = readRow();
      const msg = $('#goal-msg');
      if (!row.name) { msg.textContent = 'Informe o nome da meta.'; return; }
      if (!(row.target > 0)) { msg.textContent = 'Informe o valor da meta.'; return; }
      if (!goal && !(row.saved >= 0)) { msg.textContent = 'Valor guardado inválido.'; return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      await save({ ...row, color }, goal ? 'Meta atualizada' : 'Meta criada');
      btn.disabled = false;
    };

    // Guardar / retirar dinheiro da meta
    const move = async (sign) => {
      const v = parseMoney($('#goal-move-val').value);
      if (!(v > 0)) { $('#goal-msg').textContent = 'Digite o valor para guardar ou retirar.'; $('#goal-move-val').focus(); return; }
      const saved = round2(Number(goal.saved) + sign * v);
      if (saved < 0) { $('#goal-msg').textContent = `Você só tem ${brl(Number(goal.saved))} guardado nessa meta.`; return; }
      // Se o nome, o valor, o prazo ou a cor foram editados, salva junto (não descarta o que foi digitado)
      const row = readRow();
      const edits = row.name && row.target > 0 ? { name: row.name, target: row.target, deadline: row.deadline, color } : {};
      const target = edits.target ?? Number(goal.target);
      const reached = sign > 0 && saved >= target && Number(goal.saved) < target;
      await save({ ...edits, saved }, reached ? '🎉 Meta alcançada!' : sign > 0 ? `Guardado ${brl(v)}` : `Retirado ${brl(v)}`);
    };
    if (goal) {
      $('#goal-in').onclick = () => move(1);
      $('#goal-out').onclick = () => move(-1);
      $('#goal-del').onclick = async () => {
        if (!confirm(`Apagar a meta "${goal.name}"?`)) return;
        const { error } = await sb.from('goals').delete().eq('id', goal.id);
        if (error) { $('#goal-msg').textContent = 'Erro ao apagar: ' + error.message; return; }
        state.goals = state.goals.filter((x) => x.id !== goal.id);
        closeSheet();
        render();
        toast('Meta apagada');
      };
    }
  }

  // ---------- Conferir fatura (PDF, CSV ou OFX do banco) ----------
  // Tudo acontece no celular: o arquivo não é enviado para nenhum servidor.
  const MON = { jan: 0, fev: 1, feb: 1, mar: 2, abr: 3, apr: 3, mai: 4, may: 4, jun: 5, jul: 6, ago: 7, aug: 7, set: 8, sep: 8, out: 9, oct: 9, nov: 10, dez: 11, dec: 11 };
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // "1.234,56" | "1234.56" | "-50,00" | "50,00-" | "(50,00)" → número
  function parseAmount(raw) {
    const c = String(raw).replace(/\s/g, '');
    // só sinal, R$, parênteses, "D"/"C" no fim e dígitos com . e , ("1e308", "0x10", "12abc" → inválido)
    if (!/^[-+(]?(R\$)?[-+]?[\d.,]+\)?-?[DC]?$/i.test(c)) return NaN;
    const neg = /^-|-$|^\(.*\)$|^-?R\$-/i.test(c);
    let s = c.replace(/[^\d.,]/g, '');
    if (/^([1-9]\d{0,2}(\.\d{3})+|\d+),\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
    else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');                        // 1.500
    else if (/^([1-9]\d{0,2}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, '');        // 1,234.56 (OFX/CSV em inglês)
    else return NaN;                                                                          // "0,001", "1.2.3,4"
    const v = parseFloat(s);
    return Number.isFinite(v) ? round2(neg ? -v : v) : NaN;
  }

  // Data sem ano: usa o ano que deixa a compra antes do vencimento da fatura
  function resolveDate(d, m, y, idx) {
    if (y == null) { y = Math.floor(idx / 12); if (y * 12 + m > idx) y--; }
    else if (y < 100) y += 2000;
    if (!(m >= 0 && m <= 11 && d >= 1 && d <= 31)) return null;
    return dateStr(y * 12 + m, d);
  }

  function parseDateText(s, idx) {
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return resolveDate(+m[3], +m[2] - 1, +m[1], idx);
    m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/.exec(s);
    if (m) return resolveDate(+m[1], +m[2] - 1, m[3] ? +m[3] : null, idx);
    m = /^(\d{1,2})[\s/.-]*([a-zç]{3})[a-zç]*\.?(?:[\s/.-]+(\d{4}))?/i.exec(norm(s));
    if (m && m[2] in MON) return resolveDate(+m[1], MON[m[2]], m[3] ? +m[3] : null, idx);
    return null;
  }

  // Parcela na descrição → { k, n } e descrição sem o trecho. Aceita "Parcela 3/10", "PARC 02/12", "parcela 3 de 10",
  // "03/10" (dois dígitos) e "4/12" no fim. Não pega "1/2 porção" nem "24/7".
  function splitInstallment(desc) {
    const pats = [
      /\bparc(?:ela)?\.?\s*(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\b/i,
      /(?:^|\s)(\d{2})\/(\d{2})(?=\s|$)/,
      /(?:^|\s)(\d{1,2})\/(\d{1,2})\s*$/,
    ];
    for (const re of pats) {
      const m = re.exec(desc);
      if (!m) continue;
      const k = +m[1], n = +m[2];
      if (n >= 2 && n <= 48 && k >= 1 && k <= n) return { k, n, desc: desc.replace(m[0], ' ').replace(/\s+/g, ' ').replace(/[\s\-–·]+$/, '').trim() };
    }
    return { k: 1, n: 1, desc };
  }

  const IGNORE_RE = /pagamento|pgto\b|^total|total a pagar|saldo|limite|minimo|vencimento|fechamento|emissao|periodo|melhor dia|fatura anterior|encargos do rotativo/;

  const MAX_IMPORT_AMOUNT = 1000000; // lançamento acima de R$ 1 milhão num arquivo de fatura = arquivo estranho
  function makeItem(date, desc, amount) {
    if (!(Math.abs(amount) <= MAX_IMPORT_AMOUNT)) return null;
    desc = String(desc).slice(0, 200).replace(/R\$/g, '') // corta antes dos regex (texto gigante travava o app).replace(/[•*]{2,}\s*\d{4}/g, '').replace(/\s+/g, ' ').replace(/^[\s\-–·|]+|[\s\-–·|]+$/g, '').trim();
    if (!date || !/[a-z]/i.test(norm(desc)) || !Number.isFinite(amount) || IGNORE_RE.test(norm(desc))) return null; // sem letras = linha de datas/valores
    const inst = splitInstallment(desc);
    return { date, desc: inst.desc || desc, amount, k: inst.k, n: inst.n };
  }

  // Linhas de texto do PDF → lançamentos ("12 NOV Mercado R$ 34,90", "12/11 UBER 2345,67", "05 NOV 2025 LOJA 9,90")
  const MON_ALT = 'jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez';
  function itemsFromLines(lines, idx) {
    const out = [];
    const DATE_RE = new RegExp(`^(\\d{1,2})(?:\\/(\\d{1,2})(?:\\/(\\d{2,4}))?|[\\s.-]*(${MON_ALT})[a-z]*\\.?(?:\\s+(20\\d{2}))?)(?=\\s|$)`, 'i');
    // valor: com ou sem ponto de milhar; sinal de menos só colado ao valor ("-R$ 50,00", "50,00-")
    const MONEY_RE = /(-)?(?:R\$\s*)?(-)?(?<![\d.,])((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})(?![\d,])(-)?/g;
    // fatura em duas colunas: quebra a linha onde começa outra data logo depois de um valor
    const SPLIT_RE = new RegExp(`(?<=\\d,\\d{2}-?)\\s+(?=\\d{1,2}(?:\\/\\d{1,2}|\\s*(?:${MON_ALT})\\b))`, 'i');
    // um espaço só entre as palavras e no máximo 500 caracteres por linha: sem isso, um PDF com milhares de
    // espaços seguidos fazia os regex abaixo travarem o app por minutos (ReDoS)
    const clean = lines.map((l) => String(l).replace(/\s+/g, ' ').slice(0, 500));
    for (const raw of clean.flatMap((l) => l.split(SPLIT_RE))) {
      const line = raw.trim();
      const dm = DATE_RE.exec(norm(line));
      if (!dm) continue;
      const date = dm[2] ? resolveDate(+dm[1], +dm[2] - 1, dm[3] ? +dm[3] : null, idx)
        : resolveDate(+dm[1], MON[dm[4].slice(0, 3).toLowerCase()], dm[5] ? +dm[5] : null, idx);
      const rest = line.slice(dm[0].length);
      const monies = [...rest.matchAll(MONEY_RE)];
      if (!monies.length) continue;
      const last = monies[monies.length - 1];
      let desc = rest.slice(0, last.index);
      for (const mm of monies.slice(0, -1)) desc = desc.replace(mm[0], ' ');
      const neg = !!(last[1] || last[2] || last[4]);
      const it = makeItem(date, desc, (neg ? -1 : 1) * parseAmount(last[3]));
      if (it) out.push(it);
    }
    return out;
  }

  function parseCSV(text, idx) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    const first = lines[0];
    const count = (ch) => first.split(ch).length - 1;
    const sep = count(';') > count(',') ? ';' : count('\t') > count(',') ? '\t' : ',';
    const cells = (line) => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
        else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      out.push(cur.trim());
      return out.map((c) => c.slice(0, 300));
    };
    const rows = lines.map(cells);
    const head = rows[0].map(norm);
    const find = (re) => head.findIndex((h) => re.test(h));
    let iDate = find(/^(data|date|dt)/), iDesc = find(/descri|title|titulo|lancamento|historico|estabelecimento|memo|nome/), iVal = find(/valor|amount|value|quantia|montante/);
    const body = iDate >= 0 && iVal >= 0 ? rows.slice(1) : rows;
    const out = [];
    for (const r of body) {
      let date, desc, amount;
      if (iDate >= 0 && iVal >= 0) {
        date = parseDateText(r[iDate] || '', idx);
        amount = parseAmount(r[iVal] || '');
        desc = iDesc >= 0 ? r[iDesc] || '' : r.filter((_, i) => i !== iDate && i !== iVal).sort((a, b) => b.length - a.length)[0] || '';
      } else { // sem cabeçalho: adivinha pelas células
        const di = r.findIndex((c) => parseDateText(c, idx));
        const vi = r.map((c, i) => [c, i]).reverse().find(([c, i]) => i !== di && /\d[.,]\d{2}$/.test(c))?.[1] ?? -1;
        if (di < 0 || vi < 0) continue;
        date = parseDateText(r[di], idx); amount = parseAmount(r[vi]);
        desc = r.filter((_, i) => i !== di && i !== vi).sort((a, b) => b.length - a.length)[0] || '';
      }
      const it = makeItem(date, desc, amount);
      if (it) out.push(it);
    }
    return out;
  }

  function parseOFX(text, idx) {
    return text.split(/<STMTTRN>/i).slice(1).map((t) => {
      const dt = /<DTPOSTED>\s*(\d{4})(\d{2})(\d{2})/i.exec(t);
      const amt = /<TRNAMT>\s*([-+\d.,]+)/i.exec(t);
      const memo = /<MEMO>\s*([^<\r\n]+)/i.exec(t) || /<NAME>\s*([^<\r\n]+)/i.exec(t);
      if (!dt || !amt) return null;
      return makeItem(resolveDate(+dt[3], +dt[2] - 1, +dt[1], idx), memo ? memo[1] : 'Sem descrição', parseAmount(amt[1]));
    }).filter(Boolean);
  }

  // pdf.js e o worker dele com conferência de integridade (SRI): se o CDN entregar outro arquivo, não roda
  async function loadPdfJs() {
    if (!window.pdfjsLib) await loadScript(LIBS.pdf.src, LIBS.pdf.sri);
    const opts = window.pdfjsLib.GlobalWorkerOptions;
    if (!opts.workerPort) {
      const r = await fetch(LIBS.pdfWorker.src, { integrity: LIBS.pdfWorker.sri, mode: 'cors', credentials: 'omit' });
      if (!r.ok) throw new Error('Falha ao carregar o leitor de PDF');
      opts.workerPort = new Worker(URL.createObjectURL(await r.blob()));
    }
    return window.pdfjsLib;
  }

  const MAX_PDF_PAGES = 50;
  // Texto do PDF agrupado em linhas (mesma altura na página), da esquerda para a direita
  async function pdfLines(buf) {
    const lib = await loadPdfJs();
    let password;
    for (;;) {
      let doc;
      try {
        // isEvalSupported: false fecha a falha CVE-2024-4367 do pdf.js 3.x (PDF com fonte maliciosa rodando código)
        doc = await lib.getDocument({ data: buf.slice(0), password, isEvalSupported: false, enableXfa: false }).promise;
        if (doc.numPages > MAX_PDF_PAGES) throw new Error(`PDF com ${doc.numPages} páginas: o limite é ${MAX_PDF_PAGES}`);
        const lines = [];
        for (let p = 1; p <= doc.numPages; p++) {
          const { items } = await (await doc.getPage(p)).getTextContent();
          const rows = [];
          for (const it of items) {
            if (!it.str.trim()) continue;
            const y = it.transform[5], x = it.transform[4];
            let row = rows.find((r) => Math.abs(r.y - y) < 3);
            if (!row) rows.push((row = { y, parts: [] }));
            row.parts.push({ x, s: it.str });
          }
          rows.sort((a, b) => b.y - a.y).forEach((r) => lines.push(r.parts.sort((a, b) => a.x - b.x).map((q) => q.s).join(' ')));
        }
        return lines;
      } catch (err) {
        if (err?.name !== 'PasswordException') throw err;
        password = prompt(err.code === 2 ? 'Senha incorreta. Tente de novo:' : 'Esse PDF tem senha (muitos bancos usam os primeiros dígitos do CPF). Digite a senha:');
        if (password == null) throw new Error('PDF com senha: conferência cancelada');
      } finally {
        doc?.destroy(); // libera o documento (e a senha) da memória
      }
    }
  }

  const MAX_STATEMENT_BYTES = 5 * 1024 * 1024, MAX_STATEMENT_ITEMS = 500;
  // Lê o arquivo uma vez e devolve parse(idx): as datas sem ano dependem do mês da fatura escolhido
  async function loadStatement(file) {
    if (file.size > MAX_STATEMENT_BYTES) throw new Error('arquivo grande demais (máximo 5 MB)');
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      const lines = await pdfLines(await file.arrayBuffer());
      return (idx) => finishItems(itemsFromLines(lines, idx), false);
    }
    const text = await file.text();
    return (idx) => finishItems(/<STMTTRN>/i.test(text) ? parseOFX(text, idx) : parseCSV(text, idx), true);
  }

  function finishItems(items, fixSign) {
    if (fixSign) {
      // Alguns bancos exportam as compras com sinal negativo. Um estorno/crédito no arquivo mostra o costume do banco;
      // sem isso, vale a maioria.
      const credit = items.find((i) => /estorno|credito|devoluc|reembolso|cashback/.test(norm(i.desc)));
      const flip = credit ? credit.amount > 0 : items.filter((i) => i.amount < 0).length > items.filter((i) => i.amount > 0).length;
      if (flip) items.forEach((i) => (i.amount = -i.amount));
    }
    const credits = items.filter((i) => !(i.amount > 0)).length; // estornos e créditos ficam de fora
    return { items: items.filter((i) => i.amount > 0), credits };
  }

  // Categoria pelo histórico (mesma palavra em gasto anterior) ou por palavras conhecidas
  function guessCategory(desc) {
    const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
    // Nomes que enganam o histórico ("Uber Eats" não é Uber, "Mercado Livre" não é mercado)
    const strong = [['Alimentação', /uber ?eats|ifood|rappi/], ['Compras', /mercado ?livre|amazon|shopee|aliexpress/]];
    const hit = strong.find(([, re]) => re.test(norm(desc)));
    if (hit) return hit[0];
    const mine = new Set(words(desc));
    let best = null, score = 0;
    for (const e of state.expenses) {
      const sc = words(e.description).filter((w) => mine.has(w)).length;
      if (sc > score) { score = sc; best = e.category; }
    }
    if (best) return best;
    const d = norm(desc);
    const rules = [ // a ordem importa: o mais específico primeiro
      ['Alimentação', /ifood|uber ?eats|restaur|lanch|burger|pizza|padaria|cafe|rappi|mcdonald|\bbk\b|churrasc/],
      ['Compras', /amazon|shopee|mercado ?livre|magalu|aliexpress|shein|americanas/],
      ['Assinaturas', /netflix|spotify|prime video|disney|youtube|hbo|max\.com|globoplay|apple\.com|google one|icloud/],
      ['Transporte', /\buber\b|99app|\b99\b|posto|shell|ipiranga|combust|estacion|pedagio|sem parar|veloe/],
      ['Mercado', /mercad|supermerc|atacad|assai|carrefour|hortifruti|acougue/],
      ['Saúde', /farm|drog|raia|pague menos|clinica|hospital|laborat/],
      ['Contas', /\b(claro|vivo|tim|oi|enel|sabesp|copel|cemig)\b|energia|internet/],
    ];
    return (rules.find(([, re]) => re.test(d)) || ['Outros'])[0];
  }

  // Data de compra que cai na fatura do mês idx (um dia antes do fechamento)
  function dateForInvoice(card, idx) {
    let c = card.due_day <= card.closing_day ? idx - 1 : idx; // mês do fechamento
    if (card.closing_day > 1) return dateStr(c, card.closing_day - 1);
    c -= 1;
    return dateStr(c, daysIn(c));
  }

  // Compara a fatura do banco com o que está lançado no app (mesmo valor; desempata pelo nome e pela data)
  function compareInvoice(stmt, card, idx) {
    const app = entriesForMonth(idx).filter((e) => e.card && e.card.id === card.id);
    const used = new Set();
    const words = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
    const matched = [], missing = [];
    for (const s of stmt) {
      const sw = words(s.desc);
      let best = -1, bestScore = -Infinity;
      app.forEach((a, i) => {
        if (used.has(i) || Math.abs(a.total - s.amount) > 0.01) return; // o banco cobra o valor cheio (sem divisão)
        const name = [...words(a.exp.description)].filter((w) => sw.has(w)).length;
        const days = Math.abs(new Date(a.exp.purchase_date) - new Date(s.date)) / 864e5;
        const sc = name * 100 - Math.min(days, 60);
        if (sc > bestScore) { bestScore = sc; best = i; }
      });
      if (best >= 0) { used.add(best); matched.push({ s, a: app[best] }); } else missing.push(s);
    }
    return { matched, missing, extra: app.filter((_, i) => !used.has(i)) };
  }

  function rowFromStatement(s, card, idx) {
    const start = idx - (s.k - 1); // parcela 3/10 → a 1ª caiu 2 meses antes
    const date = s.date && invoiceMonth(s.date, card) === start ? s.date : dateForInvoice(card, start);
    return {
      description: s.desc.slice(0, 80), amount: s.n > 1 ? round2(s.amount * s.n) : s.amount,
      category: guessCategory(s.desc), purchase_date: date, card_id: card.id,
      installments: s.n, recurring: false, recur_count: null, split_divisor: 1, recur_changes: [],
    };
  }

  function openInvoiceCheck() {
    if (!state.cards.length) { toast('Cadastre o cartão primeiro (aba Cartões).'); return; }
    const months = [state.month - 1, state.month, state.month + 1];
    openSheet(`
      <h3>Conferir fatura</h3>
      <p class="muted sheet-note">Envie a fatura do banco em PDF, CSV ou OFX. O app compara com o que você lançou e mostra o que está faltando. O arquivo é lido só no seu celular.</p>
      <form id="chk-form" novalidate>
        <div><label style="margin-bottom:6px">Cartão</label>${chipGroup('card', state.cards.map((c) => [c.id, `▭ ${esc(c.name)}`]), state.cards[0].id)}</div>
        <div><label style="margin-bottom:6px">Fatura que vence em</label>${chipGroup('month', months.map((m) => [m, shortMonth(m)]), state.month)}</div>
        <label class="file-pick">
          <input type="file" id="chk-file" accept=".pdf,.csv,.ofx,.txt,application/pdf,text/csv">
          <span>📄 Escolher arquivo da fatura</span>
        </label>
      </form>
      <div id="chk-result"></div>`);
    const form = $('#chk-form');
    let last = null; // { parse, stmt, credits, card, idx, fileName }
    const rerun = () => {
      if (!last) return;
      last.card = cardById(chipVal(form, 'card'));
      const idx = Number(chipVal(form, 'month'));
      if (idx !== last.idx) { const r = last.parse(idx); Object.assign(last, { idx, stmt: r.items, credits: r.credits }); } // relê datas sem ano
      showResult();
    };
    bindChips(form, rerun);

    $('#chk-file').onchange = async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const box = $('#chk-result');
      box.innerHTML = '<p class="muted" style="text-align:center">Lendo a fatura…</p>';
      const idx = Number(chipVal(form, 'month'));
      try {
        const parse = await loadStatement(file);
        const { items, credits } = parse(idx);
        if (items.length > MAX_STATEMENT_ITEMS) throw new Error(`a fatura tem ${items.length} lançamentos e o limite é ${MAX_STATEMENT_ITEMS}`);
        last = { parse, stmt: items, credits, card: cardById(chipVal(form, 'card')), idx, fileName: file.name };
        showResult();
      } catch (err) {
        last = null;
        box.innerHTML = `<p class="msg error">Não consegui ler o arquivo: ${esc(err.message)}</p>`;
      }
      ev.target.value = '';
    };

    function showResult() {
      const box = $('#chk-result');
      if (!box) return;
      const { stmt, credits, card, idx, fileName } = last;
      if (!stmt.length) {
        box.innerHTML = `<p class="msg error">Não encontrei lançamentos em "${esc(fileName)}". Se for PDF, tente o CSV ou OFX que o app do banco exporta.</p>`;
        return;
      }
      const { matched, missing, extra } = compareInvoice(stmt, card, idx);
      const sum = (a) => round2(a.reduce((s, x) => s + x, 0));
      const bank = sum(stmt.map((s) => s.amount)), app = sum([...matched.map((m) => m.a.total), ...extra.map((e) => e.total)]);
      const diff = round2(bank - app);
      const label = (s) => `${fmtDate(s.date)}${s.n > 1 ? ` · ${s.k}/${s.n}` : ''}`;
      box.innerHTML = `
        <div class="chk-sum">
          <div><small>Fatura do banco</small><b class="num">${brl(bank)}</b><span class="muted">${stmt.length} itens</span></div>
          <div><small>Lançado no app</small><b class="num">${brl(app)}</b><span class="muted">${matched.length + extra.length} itens</span></div>
        </div>
        <p class="chk-diff ${Math.abs(diff) < 0.01 ? 'ok' : 'bad'}">${Math.abs(diff) < 0.01 ? '✅ Tudo certo: os totais batem.' : `Diferença de ${brl(Math.abs(diff))} ${diff > 0 ? 'a mais no banco' : 'a mais no app'}`}</p>
        ${missing.length ? `
          <h4>Faltam no app (${missing.length})</h4>
          <ul class="list chk-list">${missing.map((s, i) => `
            <li class="item"><label class="chk-line"><input type="checkbox" data-miss="${i}" checked>
              <span class="grow"><span class="title">${esc(s.desc)}</span><span class="sub">${label(s)} · ${CAT_ICON[guessCategory(s.desc)] || '📦'} ${esc(guessCategory(s.desc))}</span></span>
              <b class="num">${brl(s.amount)}</b></label></li>`).join('')}
          </ul>
          <button class="btn primary" type="button" id="chk-add" style="width:100%;margin-top:8px">Adicionar os marcados ao app</button>` : ''}
        ${extra.length ? `
          <h4>No app, mas não na fatura (${extra.length})</h4>
          <p class="muted sheet-note">Pode ser compra lançada no mês errado, valor diferente ou algo que ainda não entrou na fatura.</p>
          <ul class="list">${extra.map(entryRow).join('')}</ul>` : ''}
        ${matched.length ? `<p class="muted sheet-note">✔ ${matched.length} lançamento(s) conferido(s).</p>` : ''}
        ${credits ? `<p class="muted sheet-note">${credits} crédito(s) ou estorno(s) ficaram de fora (pagamentos também são ignorados).</p>` : ''}`;
      box.querySelectorAll('[data-exp]').forEach((el) => {
        el.onclick = () => openExpenseForm(state.expenses.find((x) => x.id === el.dataset.exp));
      });
      const add = $('#chk-add');
      if (add) add.onclick = async () => {
        const pick = [...box.querySelectorAll('[data-miss]:checked')].map((c) => missing[Number(c.dataset.miss)]);
        if (!pick.length) { toast('Marque pelo menos um lançamento'); return; }
        if (pick.length > 50 && !confirm(`Adicionar ${pick.length} lançamentos de uma vez?`)) return;
        add.disabled = true;
        const added = [];
        let error = null;
        for (let i = 0; i < pick.length && !error; i += 100) { // em lotes de 100
          const r = await sb.from('expenses').insert(pick.slice(i, i + 100).map((s) => withProfile(rowFromStatement(s, card, idx)))).select();
          if (r.error) error = r.error; else added.push(...r.data);
        }
        add.disabled = false;
        if (added.length) { state.expenses.unshift(...added); render(); showResult(); }
        if (error) { toast(`Erro ao adicionar${added.length ? ` (${added.length} já entraram)` : ''}: ${error.message}`); return; }
        toast(`${added.length} lançamento(s) adicionado(s)`);
      };
    }
  }

  // ---------- Avisos de vencimento (notificações) ----------
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const swReady = () => Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 4000))]);
  const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

  async function saveSub(sub) {
    const j = sub.toJSON();
    const { error } = await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
    if (error) throw error;
  }

  // Descobre se este celular recebe avisos. Se já recebia, liga o celular à conta atual (automático).
  async function refreshPush() {
    let st;
    try {
      if (!pushSupported()) st = 'unsupported';
      else if (Notification.permission === 'denied') st = 'denied';
      else {
        const reg = await swReady();
        const sub = reg && (await reg.pushManager.getSubscription());
        st = sub && Notification.permission === 'granted' ? 'on' : 'off';
        if (st === 'on' && !pushSynced && state.session) { pushSynced = true; saveSub(sub).catch(() => { pushSynced = false; }); }
      }
    } catch { st = 'off'; }
    if (st !== state.push) {
      state.push = st;
      if (['menu', 'resumo'].includes(state.tab) && $('#sheet').hidden && !$('#app').hidden) render();
    }
  }

  let pushBusy = false;
  async function enablePush() {
    if (pushBusy) return; // toque duplo
    pushBusy = true;
    let sub = null;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { await refreshPush(); toast('Sem permissão para notificações'); return; }
      const reg = await swReady();
      if (!reg) throw new Error('o app ainda não terminou de instalar. Tente de novo em alguns segundos');
      const { data, error } = await sb.functions.invoke('due-reminders', { body: { action: 'key' } });
      if (error || !data?.publicKey) throw new Error(error?.message || 'servidor sem chave');
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe(); // chave antiga: inscreve de novo
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(data.publicKey) });
      await saveSub(sub);
      pushSynced = true;
      state.push = 'on';
      render();
      toast('Avisos ativados');
      sb.functions.invoke('due-reminders', { body: { action: 'test' } }).catch(() => {}); // notificação de teste
    } catch (err) {
      // o servidor não guardou o celular: desfaz a inscrição para a tela não dizer "Ativados" sem ser verdade
      if (sub) { try { await sub.unsubscribe(); } catch {} }
      pushSynced = false;
      await refreshPush();
      toast('Não foi possível ativar: ' + err.message);
    } finally {
      pushBusy = false;
    }
  }

  // Desliga os avisos deste celular (toggle no Menu)
  async function disablePush() {
    try {
      const reg = await swReady();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) {
        const { error } = await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        if (error) { toast('Não foi possível desativar agora: ' + error.message); return; }
        await sub.unsubscribe();
      }
    } catch {}
    state.push = 'off';
    render();
    toast('Avisos desativados neste celular');
  }

  // Ao sair da conta: este celular para de receber os avisos dela (a inscrição do navegador continua,
  // e quem entrar depois passa a receber os avisos da própria conta)
  async function unlinkPush() {
    try {
      if (!pushSupported()) return;
      const reg = await swReady();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    } catch {}
  }

  function pushCard() {
    const st = state.push;
    let body;
    if (st === 'unsupported') body = '<p class="muted card-note">Este navegador não aceita notificações. No Android, abra o app pelo Chrome e instale (menu ⋮ → Adicionar à tela inicial).</p>';
    else if (st === 'denied') body = '<p class="muted card-note">As notificações estão bloqueadas para o app. Libere em Configurações do celular → Apps → Notificações e volte aqui.</p>';
    else if (st === 'on') body = `<p class="card-note">✅ Ativados neste celular. Você recebe um aviso às 9h, 3 dias antes e no dia do vencimento de cada fatura.</p>
      <div class="btn-row"><button class="btn small" id="push-test">Enviar teste</button><button class="btn small" id="push-off">Desativar</button></div>`;
    else if (st === 'off') body = `<p class="muted card-note">Receba uma notificação 3 dias antes e no dia do vencimento de cada fatura, mesmo com o app fechado.</p>
      <button class="btn primary small" id="push-on">🔔 Ativar avisos</button>`;
    else body = '<p class="muted card-note">Verificando…</p>';
    return `<section class="card"><h2>Avisos de vencimento</h2>${body}</section>`;
  }

  // ---------- Formulário de cartão ----------
  function openCardForm(card) {
    const c = card || { name: '', closing_day: 3, due_day: 10, color: COLORS[state.cards.length % COLORS.length] };
    openSheet(`
      <h3>${card ? 'Editar cartão' : 'Novo cartão'}</h3>
      <form id="card-form" novalidate>
        <label>Nome<input name="name" maxlength="40" required placeholder="Ex.: Nubank" value="${esc(c.name)}"></label>
        <div class="grid2">
          <label>Dia do fechamento<input type="number" name="closing_day" min="1" max="31" required value="${c.closing_day}"></label>
          <label>Dia do vencimento<input type="number" name="due_day" min="1" max="31" required value="${c.due_day}"></label>
        </div>
        <div><label style="margin-bottom:6px">Cor</label>
          <div class="color-row">${COLORS.map((col) =>
            `<button type="button" data-color="${col}" class="${col === c.color ? 'on' : ''}" style="background:${col}" aria-label="Cor ${col}"></button>`).join('')}</div></div>
        <p class="msg error" id="card-msg"></p>
        <div class="sheet-actions">
          <button class="btn primary" type="submit">${card ? 'Salvar alterações' : 'Adicionar cartão'}</button>
          ${card ? '<button class="btn danger" type="button" id="card-del">Excluir cartão</button>' : ''}
        </div>
      </form>`);

    const form = $('#card-form');
    let color = c.color;
    form.querySelectorAll('[data-color]').forEach((b) => {
      b.onclick = () => { color = b.dataset.color; form.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b)); };
    });
    if (!card) setTimeout(() => form.name.focus(), 50);

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const row = { name: form.name.value.trim(), closing_day: Number(form.closing_day.value), due_day: Number(form.due_day.value), color };
      const msg = $('#card-msg');
      if (!row.name) { msg.textContent = 'Informe o nome do cartão.'; return; }
      if (![row.closing_day, row.due_day].every((d) => Number.isInteger(d) && d >= 1 && d <= 31)) { msg.textContent = 'Os dias devem ser números inteiros entre 1 e 31.'; return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true; // evita cadastrar o mesmo cartão duas vezes com toque duplo
      const res = card
        ? await sb.from('cards').update(row).eq('id', card.id).select().single()
        : await sb.from('cards').insert(withProfile(row)).select().single();
      btn.disabled = false;
      if (res.error) { msg.textContent = 'Erro ao salvar: ' + res.error.message; return; }
      if (card) state.cards = state.cards.map((x) => (x.id === card.id ? res.data : x));
      else state.cards.push(res.data);
      closeSheet();
      render();
      toast(card ? 'Cartão atualizado' : 'Cartão adicionado');
    };

    const del = $('#card-del');
    if (del) del.onclick = async () => {
      const used = state.expenses.filter((x) => x.card_id === card.id || (x.recur_changes || []).some((c) => c.card_id === card.id)).length;
      const warn = used ? `\n\n${used} gasto(s) desse cartão passarão a contar como "Pix / boleto", no mês da COMPRA (não mais no mês da fatura). Por isso os totais de meses passados podem mudar.` : '';
      if (!confirm(`Excluir o cartão "${card.name}"?${warn}`)) return;
      const { error } = await sb.from('cards').delete().eq('id', card.id);
      if (error) { $('#card-msg').textContent = 'Erro ao excluir: ' + error.message; return; }
      state.cards = state.cards.filter((x) => x.id !== card.id);
      state.expenses = state.expenses.map((x) => ({
        ...x, card_id: x.card_id === card.id ? null : x.card_id,
        recur_changes: (x.recur_changes || []).map((c) => (c.card_id === card.id ? { ...c, card_id: null } : c)),
      }));
      closeSheet();
      render();
      toast('Cartão excluído');
    };
  }

  // ---------- Exportar Excel (mesmo layout das planilhas de fatura) ----------
  // Bibliotecas carregadas sob demanda, com o hash do arquivo exato (SRI): se o CDN mudar o arquivo, o navegador recusa
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const LIBS = {
    excel: { src: CDN + 'exceljs@4.4.0/dist/exceljs.min.js', sri: 'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz' },
    pdf: { src: CDN + 'pdfjs-dist@3.11.174/build/pdf.min.js', sri: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e' },
    pdfWorker: { src: CDN + 'pdfjs-dist@3.11.174/build/pdf.worker.min.js', sri: 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2' },
  };
  function loadScript(src, integrity) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.integrity = integrity; s.crossOrigin = 'anonymous';
      s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar ' + src));
      document.head.appendChild(s);
    });
  }

  async function exportExcel() {
    const btn = $('#export');
    btn.disabled = true;
    btn.textContent = 'Gerando…';
    try {
      if (!window.ExcelJS) await loadScript(LIBS.excel.src, LIBS.excel.sri);
      const idx = state.month;
      const groups = monthGroups(idx);
      const wb = new ExcelJS.Workbook();
      const money = '"R$" #,##0.00';

      // Página1: um bloco por grupo (contas fixas, Pix/boleto/dinheiro, cada cartão)
      const ws = wb.addWorksheet('Página1');
      ws.columns = [{ width: 44 }, { width: 12 }, { width: 16 }];
      const totalCells = [];
      groups.forEach((inv) => {
        const head = ws.addRow([inv.xlsTitle]);
        ws.mergeCells(head.number, 1, head.number, 3);
        head.font = { bold: true };
        head.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
        const first = head.number + 1;
        inv.items.forEach((e) => {
          const name = e.exp.description.toUpperCase();
          const parc = e.exp.recurring && !e.n ? '(FIXO)' : e.n > 1 ? `(${pad2(e.inst)}/${pad2(e.n)})` : '';
          const r = ws.addRow([name, parc, e.mine]);
          r.getCell(2).alignment = { horizontal: 'center' };
          r.getCell(3).numFmt = money;
        });
        const last = ws.lastRow.number;
        const t = ws.addRow(['TOTAL:', '', { formula: `SUM(C${first}:C${last})`, result: inv.total }]);
        t.font = { bold: true };
        t.getCell(3).numFmt = money;
        totalCells.push(`C${t.number}`);
        ws.addRow([]);
      });
      const sumAll = round2(groups.reduce((s, i) => s + i.total, 0));
      const s = ws.addRow(['TOTAL DO MÊS:', '', { formula: totalCells.join('+') || '0', result: sumAll }]);
      s.font = { bold: true };
      s.getCell(3).numFmt = money;

      // Página2: detalhe de cada gasto
      const ws2 = wb.addWorksheet('Página2');
      ws2.columns = [
        { header: 'Forma', width: 18 }, { header: 'Data', width: 12 }, { header: 'Item', width: 36 },
        { header: 'Parcela', width: 10 }, { header: 'Valor da parcela', width: 16 },
      ];
      ws2.getRow(1).font = { bold: true };
      groups.forEach((g) => g.items.forEach((e) => {
        const r = ws2.addRow([g.card ? g.card.name : (e.exp.recurring ? 'Conta fixa' : 'Pix/boleto/dinheiro'), fmtDate(e.exp.purchase_date), e.exp.description, instLabel(e) || '1/1', e.total]);
        r.getCell(5).numFmt = money;
      }));

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `GASTOS ${MONTHS[idx % 12].toUpperCase()} ${Math.floor(idx / 12)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Planilha gerada');
    } catch (err) {
      toast('Erro ao exportar: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇ Exportar Excel';
    }
  }

  // ---------- Início ----------
  applyTheme(getTheme());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(getTheme()); if (!$('#app').hidden) render(); });
  if ('serviceWorker' in navigator) {
    // Quando uma versão nova do app é instalada, recarrega uma vez para já mostrar a atualização
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        // Confere atualizações ao voltar para o app (ex.: depois de minimizado)
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      })
      .catch(() => {});
  }
  // A tela inicial (login ou app) é decidida pelo onAuthStateChange, que dispara ao abrir (evento INITIAL_SESSION)
  try {
    if (sessionStorage.getItem('signedOutOffline')) {
      sessionStorage.removeItem('signedOutOffline');
      toast('Sem internet: você saiu deste aparelho. Nos outros aparelhos a sessão continua até sair por lá.');
    }
  } catch {}
})();
