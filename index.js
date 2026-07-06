require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SteamAuth = require('node-steam-openid');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'troque_esse_segredo_em_producao',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 2 },
}));

const CONFIG = {
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN || 'COLE_SEU_ACCESS_TOKEN_DE_PRODUCAO_AQUI',
  GMOD_SHARED_SECRET: process.env.GMOD_SHARED_SECRET || 'troque_por_um_segredo_compartilhado_com_o_addon',
  STEAM_API_KEY: process.env.STEAM_API_KEY || 'COLE_SUA_STEAM_API_KEY_AQUI',
  SITE_URL: process.env.SITE_URL || 'http://localhost:3001',
};

const steam = new SteamAuth({
  realm: CONFIG.SITE_URL,
  returnUrl: `${CONFIG.SITE_URL}/auth/steam/callback`,
  apiKey: CONFIG.STEAM_API_KEY,
});

const pedidos = {};
const filaCreditos = []; // [{ id, steamid, quantidade }] — consumida pelo addon Lua via HTTP
const jogadoresOnline = new Set(); // atualizado pelo próprio addon Lua a cada heartbeat

const PACOTES = {
  '80':    { gemas: 80,    preco: 1.99 },
  '160':   { gemas: 160,   preco: 3.99 },
  '375':   { gemas: 375,   preco: 7.99 },
  '550':   { gemas: 550,   preco: 12.49 },
  '1050':  { gemas: 1050,  preco: 19.99 },
  '2200':  { gemas: 2200,  preco: 39.99 },
  '3900':  { gemas: 3900,  preco: 69.99 },
  '10000': { gemas: 10000, preco: 186.99 },
};

function carregarCupons() {
  const raw = process.env.CUPONS || '';
  const cupons = {};
  raw.split(',').forEach(par => {
    const [codigo, desconto] = par.split(':');
    if (codigo && desconto) {
      cupons[codigo.trim().toUpperCase()] = parseFloat(desconto.trim());
    }
  });
  return cupons;
}

const CUPONS = carregarCupons();

app.get('/auth/steam', async (req, res) => {
  try {
    const redirectUrl = await steam.getRedirectUrl();
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Erro ao gerar URL de login Steam:', error.message);
    res.status(500).send('Erro ao iniciar login com Steam.');
  }
});

app.get('/auth/steam/callback', async (req, res) => {
  try {
    const user = await steam.authenticate(req);
    req.session.steamUser = {
      steamid: user.steamid,
      username: user.username,
      avatar: user.avatar.medium,
    };
    res.redirect('/');
  } catch (error) {
    console.error('Erro na autenticação Steam:', error.message);
    res.redirect('/?erro=login_falhou');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/me', (req, res) => {
  if (req.session.steamUser) {
    res.json({ logado: true, ...req.session.steamUser });
  } else {
    res.json({ logado: false });
  }
});

function jogadorEstaOnline(steamid64) {
  return jogadoresOnline.has(steamid64);
}

app.post('/gmod/heartbeat', (req, res) => {
  const { online_steamids, secret } = req.body;

  if (secret !== CONFIG.GMOD_SHARED_SECRET) {
    return res.status(401).json({ erro: 'Secret inválido' });
  }

  jogadoresOnline.clear();
  (online_steamids || []).forEach(id => jogadoresOnline.add(id));

  res.json({ ok: true, recebidos: jogadoresOnline.size });
});

app.get('/gmod/pendentes', (req, res) => {
  const { secret } = req.query;

  if (secret !== CONFIG.GMOD_SHARED_SECRET) {
    return res.status(401).json({ erro: 'Secret inválido' });
  }

  res.json({ pendentes: filaCreditos });
});

app.post('/gmod/confirmar', (req, res) => {
  const { id, secret } = req.body;

  if (secret !== CONFIG.GMOD_SHARED_SECRET) {
    return res.status(401).json({ erro: 'Secret inválido' });
  }

  const idx = filaCreditos.findIndex(c => c.id === id);
  if (idx !== -1) {
    filaCreditos.splice(idx, 1);
  }

  res.json({ ok: true });
});

app.get('/status-jogador/:steamid', async (req, res) => {
  try {
    const online = jogadorEstaOnline(req.params.steamid);
    res.json({ online });
  } catch (error) {
    res.status(500).json({ online: false, erro: 'Erro ao verificar' });
  }
});

app.get('/validar-cupom/:codigo', (req, res) => {
  const codigo = req.params.codigo.trim().toUpperCase();
  const desconto = CUPONS[codigo];

  if (desconto === undefined) {
    return res.status(404).json({ valido: false, erro: 'Cupom inválido ou expirado.' });
  }

  res.json({ valido: true, codigo, desconto_percentual: desconto });
});

app.get('/meu-painel', (req, res) => {
  if (!req.session.steamUser) {
    return res.status(401).json({ erro: 'Não autenticado' });
  }

  const meuSteamid = req.session.steamUser.steamid;
  const minhasCompras = Object.entries(pedidos)
    .filter(([_, pedido]) => pedido.steamid === meuSteamid)
    .map(([paymentId, pedido]) => ({
      payment_id: paymentId,
      gemas: pedido.gemas,
      status: pedido.status,
    }));

  const totalGemasCompradas = minhasCompras
    .filter(p => p.status === 'approved')
    .reduce((acc, p) => acc + p.gemas, 0);

  res.json({
    steamid: meuSteamid,
    username: req.session.steamUser.username,
    total_gemas_compradas: totalGemasCompradas,
    historico: minhasCompras,
  });
});

app.post('/gerar-pix', async (req, res) => {
  try {
    const { pacote, steamid, email, cupom } = req.body;

    if (!req.session.steamUser || req.session.steamUser.steamid !== steamid) {
      return res.status(401).json({ erro: 'É necessário fazer login com a Steam antes de comprar.' });
    }

    if (!pacote || !PACOTES[pacote]) {
      return res.status(400).json({ erro: 'Pacote inválido' });
    }
    if (!email) {
      return res.status(400).json({ erro: 'Email do comprador é obrigatório' });
    }

    const { gemas } = PACOTES[pacote];
    let preco = PACOTES[pacote].preco;
    let cupomAplicado = null;

    if (cupom) {
      const codigoCupom = String(cupom).trim().toUpperCase();
      const desconto = CUPONS[codigoCupom];
      if (desconto !== undefined) {
        preco = Math.round((preco * (1 - desconto / 100)) * 100) / 100;
        cupomAplicado = codigoCupom;
      }
    }

    const idempotencyKey = crypto.randomUUID();

    const response = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      {
        transaction_amount: preco,
        description: `Pacote ${gemas} Gemas - Servidor GMod${cupomAplicado ? ` (cupom ${cupomAplicado})` : ''}`,
        payment_method_id: 'pix',
        payer: { email },
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
      }
    );

    const payment = response.data;

    pedidos[payment.id] = {
      steamid,
      gemas,
      status: 'pending',
      cupom: cupomAplicado,
    };

    res.json({
      payment_id: payment.id,
      qr_code: payment.point_of_interaction.transaction_data.qr_code,
      qr_code_base64: payment.point_of_interaction.transaction_data.qr_code_base64,
      valor: preco,
      gemas,
      cupom_aplicado: cupomAplicado,
    });
  } catch (error) {
    console.error('Erro ao gerar Pix:', error.response?.data || error.message);
    res.status(500).json({ erro: 'Erro ao gerar pagamento', detalhe: error.response?.data });
  }
});

app.get('/status-pagamento/:id', async (req, res) => {
  try {
    const paymentId = req.params.id;
    const pedido = pedidos[paymentId];

    if (!pedido) {
      return res.status(404).json({ erro: 'Pedido não encontrado' });
    }

    if (pedido.status === 'approved') {
      return res.json({ status: 'approved' });
    }

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${CONFIG.MP_ACCESS_TOKEN}` } }
    );

    const payment = response.data;

    if (payment.status === 'approved' && pedido.status !== 'approved') {
      enfileirarCredito(pedido.steamid, pedido.gemas);
      pedido.status = 'approved';
      console.log(`Gemas enfileiradas (polling): ${pedido.gemas} para ${pedido.steamid}`);
    }

    res.json({ status: payment.status });
  } catch (error) {
    console.error('Erro ao consultar status:', error.response?.data || error.message);
    res.status(500).json({ erro: 'Erro ao consultar status' });
  }
});

app.post('/webhook', async (req, res) => {
  try {
    res.sendStatus(200);

    const { type, data } = req.body;
    if (type !== 'payment') return;

    const paymentId = data.id;

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${CONFIG.MP_ACCESS_TOKEN}` } }
    );

    const payment = response.data;

    if (payment.status === 'approved') {
      const pedido = pedidos[paymentId];
      if (!pedido || pedido.status === 'approved') return;

      enfileirarCredito(pedido.steamid, pedido.gemas);
      pedido.status = 'approved';
      console.log(`Gemas enfileiradas (webhook): ${pedido.gemas} para ${pedido.steamid}`);
    }
  } catch (error) {
    console.error('Erro no webhook:', error.response?.data || error.message);
  }
});

function enfileirarCredito(steamid, quantidade) {
  filaCreditos.push({
    id: crypto.randomUUID(),
    steamid,
    quantidade,
    criado_em: Date.now(),
  });
}

app.get('/', (req, res) => {
  res.send('Backend Loja de Gemas GMod está rodando');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});