// Roda antes de tudo (no <head>). Fica num arquivo, e não inline, para a CSP poder bloquear scripts inline.

// 1) Não deixa o app abrir dentro de um iframe de outro site (clickjacking).
//    O GitHub Pages não permite o cabeçalho X-Frame-Options/frame-ancestors, então a defesa é aqui.
if (window.top !== window.self) {
  document.documentElement.style.display = 'none';
  try { window.top.location.replace(window.location.href); } catch (e) {}
  throw new Error('App aberto dentro de um iframe: bloqueado');
}

// 2) Aplica o tema salvo antes de desenhar a página (evita "piscar")
try { var t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
