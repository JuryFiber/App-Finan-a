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
  const CAT_ICON = Object.fromEntries(CATEGORIES);
  // Cada categoria tem a sua cor fixa (CSS --cat-0..9, na ordem de CATEGORIES); desconhecida = "Outros"
  const catIdx = (c) => { const i = CATEGORIES.findIndex(([n]) => n === c); return i < 0 ? CATEGORIES.length - 1 : i; };
  const catColor = (c) => `var(--cat-${catIdx(c)})`;
  const CAT_DARK_INK = new Set([1, 4, 6, 9]); // cores claras: % escrito em tinta escura
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
    tab: 'resumo',
    month: now.getFullYear() * 12 + now.getMonth(), // índice absoluto do mês
  };

  // ---------- Utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const round2 = (v) => Math.round(v * 100) / 100;
  const pad2 = (n) => String(n).padStart(2, '0');
  const monthName = (idx) => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;
  const daysIn = (idx) => new Date(Math.floor(idx / 12), (idx % 12) + 1, 0).getDate();
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m: m - 1, d }; };
  const fmtDate = (s) => { const { m, d } = parseDate(s); return `${pad2(d)}/${pad2(m + 1)}`; };
  const todayStr = () => { const t = new Date(); return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`; };

  function parseMoney(s) {
    s = String(s).trim().replace(/[R$\s]/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');      // 1.234,56 → 1234.56
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');    // 1.500 → 1500 (ponto de milhar)
    const v = parseFloat(s);
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

  // Cada carregamento ganha um número; a resposta é descartada se outro carregamento começou,
  // se um formulário foi aberto (para não sobrescrever o que for salvo nele) ou se saiu da conta.
  let loadSeq = 0;
  async function loadData() {
    const seq = ++loadSeq;
    try {
      await loadProfiles();
      if (seq !== loadSeq) return;
      const [c, expenses] = await Promise.all([scoped(sb.from('cards').select('*')).order('created_at'), fetchAllExpenses()]);
      if (c.error) throw c.error;
      if (seq !== loadSeq) return;
      Object.assign(state, { cards: c.data, expenses, loadedAt: Date.now(), loadError: false });
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
    Object.assign(state, { cards: [], expenses: [], loadedAt: 0, loadError: false });
    if (state.tab === 'resumo') render(); else setTab('resumo');
    loadData();
    toast(`Perfil: ${profileName(activeProfile())}`);
  }

  // Ao voltar para o app: recarrega se o carregamento falhou ou se os dados têm mais de 5 min
  // (ex.: gastos lançados em outro aparelho enquanto este ficou aberto)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.session || !$('#sheet').hidden) return;
    if (Date.now() - state.loadedAt > 5 * 60 * 1000) loadData();
  });

  // ---------- Autenticação ----------
  let signUpMode = false;

  function showAuth() { $('#auth').hidden = false; $('#app').hidden = true; }
  function showApp() { $('#auth').hidden = true; $('#app').hidden = false; render(); loadData(); loadAvatar(); }

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
      Object.assign(state, { cards: [], expenses: [], profiles: [], profileId: null, profilesOk: false, avatarUrl: null, loadedAt: 0, loadError: false });
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
    if (nav.ignorePop > 0) { nav.ignorePop--; return; }
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
    if (!list.length) return emptyState('Nenhum gasto neste mês', 'Toque em + para lançar o primeiro.');
    const mine = round2(list.reduce((s, e) => s + e.mine, 0));
    const onCard = round2(list.filter((e) => e.card).reduce((s, e) => s + e.mine, 0));

    const byCat = {};
    list.forEach((e) => { byCat[e.exp.category] = (byCat[e.exp.category] || 0) + e.mine; });
    const cats = Object.entries(byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

    const byPay = {};
    list.forEach((e) => { const k = e.card ? e.card.name : 'Pix / boleto / dinheiro'; byPay[k] = (byPay[k] || 0) + e.mine; });

    return `
      <section class="card hero">
        <div class="label">Gastos do mês</div>
        <div class="big num">${brl(mine)}</div>
        <div class="hero-row">
          <div><small>No cartão</small><b class="num">${brl(onCard)}</b></div>
          <div><small>Pix / boleto / dinheiro</small><b class="num">${brl(round2(mine - onCard))}</b></div>
        </div>
      </section>
      <section class="card">
        <h2>Categorias</h2>
        ${donut(cats, mine)}
        <div class="cat-list">
          ${cats.map(([c, v]) => `
            <div class="cat-row">
              <div class="cat-top"><span><span class="muted">${pct(v, mine)}%</span> ${CAT_ICON[c] || '📦'} ${esc(c)}</span><b class="num">${brl(v)}</b></div>
              <div class="cat-bar" style="--c:${catColor(c)}"><i style="width:${Math.max(2, (v / cats[0][1]) * 100)}%"></i></div>
            </div>`).join('')}
        </div>
      </section>
      <section class="card">
        <h2>Por forma de pagamento</h2>
        <ul class="list">
          ${Object.entries(byPay).sort((a, b) => b[1] - a[1]).map(([k, v]) => `
            <li class="item"><div class="grow title">${esc(k)}</div><div class="val num">${brl(v)}</div></li>`).join('')}
        </ul>
      </section>`;
  }

  const pct = (v, total) => (total > 0 ? Math.round((v / total) * 100) : 0);

  // Rosca por categoria: fatias com um pequeno espaço entre elas, % em cada fatia e o total no meio
  function donut(cats, total) {
    if (!(total > 0)) return '';
    const R = 80, W = 28, C = 2 * Math.PI * R, GAP = cats.length > 1 ? 3 : 0;
    let off = 0;
    const segs = cats.map(([c, v]) => {
      const len = (v / total) * C, i = catIdx(c);
      const mid = ((off + len / 2) / C) * 2 * Math.PI - Math.PI / 2;
      const p = pct(v, total);
      const seg = `
        <circle class="seg" cx="100" cy="100" r="${R}" stroke-width="${W}" style="stroke:var(--cat-${i})"
          stroke-dasharray="${Math.max(0.5, len - GAP).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
          transform="rotate(-90 100 100)"><title>${esc(c)}: ${brl(v)} (${p}%)</title></circle>
        ${p >= 6 ? `<text x="${(100 + R * Math.cos(mid)).toFixed(1)}" y="${(100 + R * Math.sin(mid)).toFixed(1)}" class="seg-lbl${CAT_DARK_INK.has(i) ? ' ink-dark' : ''}">${p}%</text>` : ''}`;
      off += len;
      return seg;
    }).join('');
    return `
      <div class="donut" role="img" aria-label="Gastos por categoria: ${cats.map(([c, v]) => `${esc(c)} ${pct(v, total)}%`).join(', ')}">
        <svg viewBox="0 0 200 200">${segs}</svg>
        <div class="donut-center"><small>Total</small><b class="num">${brl(total)}</b></div>
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
    if (!groups.length) return emptyState('Nenhum gasto neste mês', 'Compras no cartão aparecem no mês da fatura.');
    const total = (v) => `<div class="invoice-total"><span>Total</span><span class="num">${brl(v)}</span></div>`;
    let html = '<div class="row-actions"><button class="btn primary small" id="export">⬇ Exportar Excel</button></div>';
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
            <span class="swatch" style="background:${esc(g.card.color)}"></span>
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
            <div class="dot" style="background:${esc(c.color)};color:#fff">▭</div>
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
        ? `<span class="avatar prof-av" style="background:${esc(p.color)};color:#fff">${esc(p.name[0].toUpperCase())}</span>`
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
      else { render(); toast('Perfil apagado'); }
    };
  }

  function openPasswordForm() {
    openSheet(`
      <h3>Alterar senha</h3>
      <form id="pwd-form" novalidate>
        <label>Nova senha<input type="password" name="p1" minlength="6" autocomplete="new-password" required></label>
        <label>Repita a nova senha<input type="password" name="p2" minlength="6" autocomplete="new-password" required></label>
        <p class="msg error" id="pwd-msg"></p>
        <div class="sheet-actions"><button class="btn primary" type="submit">Salvar nova senha</button></div>
      </form>`);
    const f = $('#pwd-form');
    setTimeout(() => f.p1.focus(), 50);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = $('#pwd-msg');
      if (f.p1.value.length < 6) { msg.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
      if (f.p1.value !== f.p2.value) { msg.textContent = 'As senhas não são iguais.'; return; }
      const btn = f.querySelector('[type=submit]');
      btn.disabled = true;
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
    try { await sb.storage.from('avatars').remove([avatarPath()]); } catch {}
    const { error } = await sb.rpc('delete_my_account');
    if (error) { toast('Erro ao excluir: ' + error.message); return; }
    try { localStorage.removeItem(profileKey()); } catch {}
    try { await sb.auth.signOut(); } catch {}
    toast('Conta excluída');
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

  async function loadAvatar() {
    const { data, error } = await sb.storage.from('avatars').createSignedUrl(avatarPath(), 60 * 60 * 24 * 7);
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
    const rt = $('#retry'); if (rt) rt.onclick = () => { state.loadError = false; render(); loadData(); };
    const lo = $('#logout'); if (lo) lo.onclick = () => { if (confirm('Sair da conta?')) sb.auth.signOut(); };
    bindMenu();
  }

  // ---------- Folha inferior ----------
  function openSheet(html) {
    const sh = $('#sheet');
    sh.innerHTML = `<div class="grip"></div>${html}`;
    sh.hidden = false;
    $('#sheet-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    loadSeq++; // descarta atualização em andamento (não pode sobrescrever o que for salvo aqui)
    if (!nav.sheetPushed) { history.pushState({ sheet: true }, ''); nav.sheetPushed = true; }
  }
  function closeSheet(fromPop = false) {
    if (!fromPop && nav.sheetPushed) { nav.sheetPushed = false; historyBack(); }
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
    if ($('#sheet').hidden) return; // fechou enquanto carregava
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
      `<button type="button" class="chip${String(v) === String(current) ? ' on' : ''}" data-v="${esc(v)}">${label}</button>`).join('')}</div>`;
  }
  function bindChips(root, onChange) {
    root.querySelectorAll('[data-group]').forEach((g) => {
      g.querySelectorAll('.chip').forEach((c) => {
        c.onclick = () => {
          g.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
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
        <div><label style="margin-bottom:6px">Pagamento</label>${chipGroup('card', payOpts, cur.card_id || '')}</div>
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
        txt = `${n}x de ${brl(amount / n)}`;
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
      if (!(row.closing_day >= 1 && row.closing_day <= 31 && row.due_day >= 1 && row.due_day <= 31)) { msg.textContent = 'Os dias devem estar entre 1 e 31.'; return; }
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
      const warn = used ? `\n\n${used} gasto(s) desse cartão passarão a contar como "Pix / boleto".` : '';
      if (!confirm(`Excluir o cartão "${card.name}"?${warn}`)) return;
      const { error } = await sb.from('cards').delete().eq('id', card.id);
      if (error) { $('#card-msg').textContent = 'Erro ao excluir: ' + error.message; return; }
      state.cards = state.cards.filter((x) => x.id !== card.id);
      state.expenses = state.expenses.map((x) => (x.card_id === card.id ? { ...x, card_id: null } : x));
      closeSheet();
      render();
      toast('Cartão excluído');
    };
  }

  // ---------- Exportar Excel (mesmo layout das planilhas de fatura) ----------
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar ' + src));
      document.head.appendChild(s);
    });
  }

  async function exportExcel() {
    const btn = $('#export');
    btn.disabled = true;
    btn.textContent = 'Gerando…';
    try {
      if (!window.ExcelJS) await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');
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
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getTheme()));
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
})();
