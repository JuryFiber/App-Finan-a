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
  const COLORS = ['#8a05be', '#ff7a00', '#0b6bcb', '#16a36a', '#d64545', '#111827', '#c2185b', '#00897b'];
  const SPLIT_LABEL = { 1: 'Só eu', 2: 'Dividir /2', 3: 'Dividir /3' };

  // ---------- Estado ----------
  const now = new Date();
  const state = {
    session: null,
    cards: [],
    expenses: [],
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
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
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
  // Mês (índice absoluto) da fatura em que cai a 1ª parcela de uma compra no cartão.
  function invoiceMonth(dateStr, card) {
    const { y, m, d } = parseDate(dateStr);
    let close = y * 12 + m;
    if (d > card.closing_day) close += 1;          // comprou depois do fechamento → próxima fatura
    return card.due_day <= card.closing_day ? close + 1 : close; // vencimento cai no mês seguinte ao fechamento
  }

  // Data de vencimento da fatura de um cartão em determinado mês
  function dueDate(card, idx) {
    return `${pad2(Math.min(card.due_day, daysIn(idx)))}/${pad2((idx % 12) + 1)}`;
  }

  // Quebra uma compra em lançamentos mensais (parcelas)
  function entriesOf(exp) {
    const card = state.cards.find((c) => c.id === exp.card_id) || null;
    const n = card ? exp.installments : 1;
    const amount = Number(exp.amount);
    const per = round2(amount / n);
    const start = card ? invoiceMonth(exp.purchase_date, card) : (() => { const { y, m } = parseDate(exp.purchase_date); return y * 12 + m; })();
    const out = [];
    for (let i = 0; i < n; i++) {
      const total = i === n - 1 ? round2(amount - per * (n - 1)) : per; // última parcela absorve os centavos
      const mine = round2(total / exp.split_divisor);
      out.push({ exp, card, month: start + i, inst: i + 1, n, total, mine, hers: round2(total - mine) });
    }
    return out;
  }

  const entriesForMonth = (idx) => state.expenses.flatMap(entriesOf).filter((e) => e.month === idx);

  // ---------- Dados ----------
  async function loadData() {
    const [c, e] = await Promise.all([
      sb.from('cards').select('*').order('created_at'),
      sb.from('expenses').select('*').order('purchase_date', { ascending: false }),
    ]);
    if (c.error || e.error) { toast('Erro ao carregar dados: ' + (c.error || e.error).message); return; }
    state.cards = c.data;
    state.expenses = e.data;
    render();
  }

  // ---------- Autenticação ----------
  let signUpMode = false;

  function showAuth() { $('#auth').hidden = false; $('#app').hidden = true; }
  function showApp() { $('#auth').hidden = true; $('#app').hidden = false; loadData(); }

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
    if (!session) { state.cards = []; state.expenses = []; showAuth(); }
  });

  // ---------- Navegação ----------
  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      document.querySelectorAll('.tabbar button').forEach((x) => x.classList.toggle('active', x === b));
      render();
      window.scrollTo(0, 0);
    };
  });
  $('#prev-month').onclick = () => { state.month--; render(); };
  $('#next-month').onclick = () => { state.month++; render(); };
  $('#fab').onclick = () => (state.tab === 'cartoes' ? openCardForm() : openExpenseForm());

  // ---------- Render ----------
  function render() {
    $('#month-title').textContent = monthName(state.month);
    $('#fab').setAttribute('aria-label', state.tab === 'cartoes' ? 'Novo cartão' : 'Novo gasto');
    const views = { resumo: renderResumo, gastos: renderGastos, faturas: renderFaturas, cartoes: renderCartoes };
    $('#view').innerHTML = views[state.tab]();
    bindView();
  }

  function renderResumo() {
    const list = entriesForMonth(state.month);
    if (!list.length) return emptyState('Nenhum gasto neste mês', 'Toque em + para lançar o primeiro.');
    const mine = round2(list.reduce((s, e) => s + e.mine, 0));
    const hers = round2(list.reduce((s, e) => s + e.hers, 0));
    const total = round2(mine + hers);

    const byCat = {};
    list.forEach((e) => { byCat[e.exp.category] = (byCat[e.exp.category] || 0) + e.mine; });
    const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const maxCat = cats[0][1] || 1;

    const byPay = {};
    list.forEach((e) => { const k = e.card ? e.card.name : 'À vista (Pix/dinheiro/débito)'; byPay[k] = (byPay[k] || 0) + e.mine; });

    return `
      <section class="card hero">
        <div class="label">Minha parte no mês</div>
        <div class="big num">${brl(mine)}</div>
        <div class="hero-row">
          <div><small>A receber (divididos)</small><b class="num">${brl(hers)}</b></div>
          <div><small>Total das compras</small><b class="num">${brl(total)}</b></div>
        </div>
      </section>
      <section class="card">
        <h2>Por categoria</h2>
        ${cats.map(([c, v]) => `
          <div class="bar-row"><span>${CAT_ICON[c] || '📦'} ${esc(c)}</span><b class="num">${brl(v)}</b>
            <div class="bar"><i style="width:${Math.max(3, (v / maxCat) * 100)}%"></i></div></div>`).join('')}
      </section>
      <section class="card">
        <h2>Por forma de pagamento</h2>
        <ul class="list">
          ${Object.entries(byPay).sort((a, b) => b[1] - a[1]).map(([k, v]) => `
            <li class="item"><div class="grow title">${esc(k)}</div><div class="val num">${brl(v)}</div></li>`).join('')}
        </ul>
      </section>`;
  }

  function entryRow(e) {
    const where = e.card ? esc(e.card.name) : 'À vista';
    const inst = e.n > 1 ? ` · ${e.inst}/${e.n}` : '';
    const split = e.exp.split_divisor > 1 ? ` <span class="tag">/${e.exp.split_divisor}</span>` : '';
    return `
      <li class="item tap" data-exp="${e.exp.id}">
        <div class="dot">${CAT_ICON[e.exp.category] || '📦'}</div>
        <div class="grow">
          <div class="title">${esc(e.exp.description)}${split}</div>
          <div class="sub">${where}${inst} · ${fmtDate(e.exp.purchase_date)}</div>
        </div>
        <div class="val num">${brl(e.mine)}${e.exp.split_divisor > 1 ? `<small>de ${brl(e.total)}</small>` : ''}</div>
      </li>`;
  }

  function renderGastos() {
    const list = entriesForMonth(state.month).sort((a, b) => b.exp.purchase_date.localeCompare(a.exp.purchase_date));
    if (!list.length) return emptyState('Nenhum gasto neste mês', 'Compras no cartão aparecem no mês da fatura.');
    const vista = list.filter((e) => !e.card);
    const cartao = list.filter((e) => e.card);
    let html = '';
    if (vista.length) html += `<div class="day-head">À vista</div><section class="card"><ul class="list">${vista.map(entryRow).join('')}</ul></section>`;
    if (cartao.length) html += `<div class="day-head">No cartão (fatura deste mês)</div><section class="card"><ul class="list">${cartao.map(entryRow).join('')}</ul></section>`;
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

  function renderFaturas() {
    if (!state.cards.length) return emptyState('Nenhum cartão cadastrado', 'Cadastre seus cartões na aba Cartões.');
    const invs = invoicesFor(state.month);
    if (!invs.length) return emptyState('Nenhuma fatura neste mês', 'Lance compras no cartão para vê-las aqui.');
    const sum = round2(invs.reduce((s, i) => s + i.total, 0));
    return `
      <div class="row-actions"><button class="btn primary small" id="export">⬇ Exportar Excel</button></div>
      ${invs.map((inv) => `
        <section class="card">
          <div class="invoice-head">
            <span class="swatch" style="background:${esc(inv.card.color)}"></span>
            <h2>${esc(inv.card.name)}</h2>
            <span class="muted">vence ${dueDate(inv.card, state.month)}</span>
          </div>
          <ul class="list">${inv.items.map(entryRow).join('')}</ul>
          <div class="invoice-total"><span>Total (minha parte)</span><span class="num">${brl(inv.total)}</span></div>
        </section>`).join('')}
      <section class="card sum-all"><span>Soma dos cartões</span><span class="num">${brl(sum)}</span></section>`;
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
        Compras feitas depois do dia de fechamento entram na fatura seguinte.</p>
      <div style="text-align:center"><button class="btn link" id="logout">Sair da conta</button></div>`;
  }

  function emptyState(title, sub) {
    const extra = state.tab === 'cartoes' ? '<div style="text-align:center"><button class="btn link" id="logout">Sair da conta</button></div>' : '';
    return `<div class="empty"><b>${esc(title)}</b>${esc(sub)}</div>${extra}`;
  }

  function bindView() {
    document.querySelectorAll('[data-exp]').forEach((el) => {
      el.onclick = () => openExpenseForm(state.expenses.find((x) => x.id === el.dataset.exp));
    });
    document.querySelectorAll('[data-card]').forEach((el) => {
      el.onclick = () => openCardForm(state.cards.find((x) => x.id === el.dataset.card));
    });
    const ex = $('#export'); if (ex) ex.onclick = exportExcel;
    const lo = $('#logout'); if (lo) lo.onclick = () => sb.auth.signOut();
  }

  // ---------- Folha inferior ----------
  function openSheet(html) {
    const sh = $('#sheet');
    sh.innerHTML = `<div class="grip"></div>${html}`;
    sh.hidden = false;
    $('#sheet-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    $('#sheet').hidden = true;
    $('#sheet-backdrop').hidden = true;
    document.body.style.overflow = '';
  }
  $('#sheet-backdrop').onclick = closeSheet;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

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
  function openExpenseForm(exp) {
    const e = exp || { description: '', amount: '', category: 'Mercado', purchase_date: todayStr(), card_id: '', installments: 1, split_divisor: 1 };
    const payOpts = [['', '💵 À vista'], ...state.cards.map((c) => [c.id, `▭ ${esc(c.name)}`])];
    openSheet(`
      <h3>${exp ? 'Editar gasto' : 'Novo gasto'}</h3>
      <form id="exp-form" novalidate>
        <label>Valor total da compra
          <input class="amount-input num" name="amount" inputmode="decimal" placeholder="0,00" required
            value="${exp ? String(Number(e.amount).toFixed(2)).replace('.', ',') : ''}"></label>
        <label>Descrição<input name="description" maxlength="80" required placeholder="Ex.: Mercado, Uber, Netflix" value="${esc(e.description)}"></label>
        <div><label style="margin-bottom:6px">Categoria</label>${chipGroup('category', CATEGORIES.map(([c, i]) => [c, `${i} ${c}`]), e.category)}</div>
        <div><label style="margin-bottom:6px">Pagamento</label>${chipGroup('card', payOpts, e.card_id || '')}</div>
        <div class="grid2">
          <label>Data da compra<input type="date" name="purchase_date" required value="${e.purchase_date}"></label>
          <label id="inst-wrap">Parcelas
            <select name="installments">${Array.from({ length: 24 }, (_, i) => i + 1).map((n) =>
              `<option value="${n}"${n === e.installments ? ' selected' : ''}>${n === 1 ? 'À vista (1x)' : n + 'x'}</option>`).join('')}</select></label>
        </div>
        <div><label style="margin-bottom:6px">Divisão com a namorada</label>${chipGroup('split', Object.entries(SPLIT_LABEL), e.split_divisor)}</div>
        <div class="preview" id="exp-preview"></div>
        <p class="msg error" id="exp-msg"></p>
        <div class="sheet-actions">
          <button class="btn primary" type="submit">${exp ? 'Salvar alterações' : 'Adicionar gasto'}</button>
          ${exp ? '<button class="btn danger" type="button" id="exp-del">Excluir gasto</button>' : ''}
        </div>
      </form>`);

    const form = $('#exp-form');
    const update = () => {
      const cardId = chipVal(form, 'card');
      const card = state.cards.find((c) => c.id === cardId);
      $('#inst-wrap').style.visibility = card ? 'visible' : 'hidden';
      const amount = parseMoney(form.amount.value);
      const n = card ? Number(form.installments.value) : 1;
      const div = Number(chipVal(form, 'split'));
      const pv = $('#exp-preview');
      if (!(amount > 0)) { pv.textContent = 'Digite o valor para ver o resumo.'; return; }
      const per = amount / n;
      let txt = n > 1 ? `${n}x de ${brl(per)}` : brl(amount);
      if (div > 1) txt += ` · sua parte ${brl(per / div)}${n > 1 ? ' por mês' : ''}`;
      if (card && form.purchase_date.value) txt += ` · ${n > 1 ? '1ª parcela na' : 'entra na'} fatura de ${monthName(invoiceMonth(form.purchase_date.value, card))}`;
      pv.textContent = txt;
    };
    bindChips(form, update);
    form.addEventListener('input', update);
    update();
    if (!exp) setTimeout(() => form.amount.focus(), 50);

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const cardId = chipVal(form, 'card') || null;
      const row = {
        description: form.description.value.trim(),
        amount: parseMoney(form.amount.value),
        category: chipVal(form, 'category') || 'Outros',
        purchase_date: form.purchase_date.value,
        card_id: cardId,
        installments: cardId ? Number(form.installments.value) : 1,
        split_divisor: Number(chipVal(form, 'split')) || 1,
      };
      const msg = $('#exp-msg');
      if (!(row.amount > 0)) { msg.textContent = 'Informe um valor válido.'; return; }
      if (!row.description) { msg.textContent = 'Informe uma descrição.'; return; }
      if (!row.purchase_date) { msg.textContent = 'Informe a data.'; return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      const res = exp
        ? await sb.from('expenses').update(row).eq('id', exp.id).select().single()
        : await sb.from('expenses').insert(row).select().single();
      btn.disabled = false;
      if (res.error) { msg.textContent = 'Erro ao salvar: ' + res.error.message; return; }
      if (exp) state.expenses = state.expenses.map((x) => (x.id === exp.id ? res.data : x));
      else state.expenses.unshift(res.data);
      closeSheet();
      render();
      toast(exp ? 'Gasto atualizado' : 'Gasto adicionado');
    };

    const del = $('#exp-del');
    if (del) del.onclick = async () => {
      if (!confirm(`Excluir "${exp.description}"${exp.installments > 1 ? ' e todas as parcelas' : ''}?`)) return;
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
      const res = card
        ? await sb.from('cards').update(row).eq('id', card.id).select().single()
        : await sb.from('cards').insert(row).select().single();
      if (res.error) { msg.textContent = 'Erro ao salvar: ' + res.error.message; return; }
      if (card) state.cards = state.cards.map((x) => (x.id === card.id ? res.data : x));
      else state.cards.push(res.data);
      closeSheet();
      render();
      toast(card ? 'Cartão atualizado' : 'Cartão adicionado');
    };

    const del = $('#card-del');
    if (del) del.onclick = async () => {
      const used = state.expenses.filter((x) => x.card_id === card.id).length;
      const warn = used ? `\n\n${used} gasto(s) desse cartão passarão a contar como "À vista".` : '';
      if (!confirm(`Excluir o cartão "${card.name}"?${warn}`)) return;
      const { error } = await sb.from('cards').delete().eq('id', card.id);
      if (error) { $('#card-msg').textContent = 'Erro ao excluir: ' + error.message; return; }
      state.cards = state.cards.filter((x) => x.id !== card.id);
      state.expenses = state.expenses.map((x) => (x.card_id === card.id ? { ...x, card_id: null, installments: 1 } : x));
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
      const invs = invoicesFor(idx);
      const wb = new ExcelJS.Workbook();
      const money = '"R$" #,##0.00';

      // Página1: um bloco por cartão
      const ws = wb.addWorksheet('Página1');
      ws.columns = [{ width: 44 }, { width: 12 }, { width: 16 }];
      const totalCells = [];
      invs.forEach((inv) => {
        const head = ws.addRow([`CARTÃO ${inv.card.name.toUpperCase()} VENCIMENTO ${dueDate(inv.card, idx)}`]);
        ws.mergeCells(head.number, 1, head.number, 3);
        head.font = { bold: true };
        head.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
        const first = head.number + 1;
        inv.items.forEach((e) => {
          const name = e.exp.description.toUpperCase() + (e.exp.split_divisor > 1 ? ` /${e.exp.split_divisor}` : '');
          const parc = e.n > 1 ? `(${pad2(e.inst)}/${pad2(e.n)})` : '';
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
      const sumAll = round2(invs.reduce((s, i) => s + i.total, 0));
      const s = ws.addRow(['SOMA DOS CARTOES:', '', { formula: totalCells.join('+') || '0', result: sumAll }]);
      s.font = { bold: true };
      s.getCell(3).numFmt = money;

      // Página2: detalhe com a divisão
      const ws2 = wb.addWorksheet('Página2');
      ws2.columns = [
        { header: 'Cartão', width: 14 }, { header: 'Data compra', width: 12 }, { header: 'Item', width: 36 },
        { header: 'Parcela', width: 10 }, { header: 'Valor da parcela', width: 16 }, { header: 'Minha parte', width: 14 }, { header: 'Parte dela', width: 14 },
      ];
      ws2.getRow(1).font = { bold: true };
      invs.forEach((inv) => inv.items.forEach((e) => {
        const r = ws2.addRow([inv.card.name, fmtDate(e.exp.purchase_date), e.exp.description, e.n > 1 ? `${e.inst}/${e.n}` : '1/1', e.total, e.mine, e.hers]);
        [5, 6, 7].forEach((c) => (r.getCell(c).numFmt = money));
      }));

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `FATURA CARTÃO VENCIMENTO ${MONTHS[idx % 12].toUpperCase()} ${Math.floor(idx / 12)}.xlsx`;
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  sb.auth.getSession().then(({ data }) => { if (!data.session) showAuth(); });
})();
