require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SteamAuth = require('node-steam-openid');
const axios = require('axios');
const crypto = require('crypto');
const fetch = require('node-fetch');
const {
  Client: DiscordClient,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'troque_esse_segredo_em_producao',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 },
}));

const CONFIG = {
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN || 'COLE_SEU_ACCESS_TOKEN_DE_PRODUCAO_AQUI',
  GMOD_SHARED_SECRET: process.env.GMOD_SHARED_SECRET || 'troque_por_um_segredo_compartilhado_com_o_addon',
  STEAM_API_KEY: process.env.STEAM_API_KEY || 'COLE_SUA_STEAM_API_KEY_AQUI',
  SITE_URL: process.env.SITE_URL || 'http://localhost:3001',

  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || 'COLE_SEU_DISCORD_CLIENT_ID_AQUI',
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || 'COLE_SEU_DISCORD_CLIENT_SECRET_AQUI',
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || 'COLE_SEU_DISCORD_BOT_TOKEN_AQUI',
  DISCORD_GUILD_ID: '1496885760412880976',
  DISCORD_REQUIRED_ROLE_ID: '1506354185480962190',

  // Secret separado do GMOD_SHARED_SECRET — é usado só pelo bot de
  // verificação de idade do Discord (processo externo), não pelo addon Lua.
  AGE_BOT_SHARED_SECRET: process.env.AGE_BOT_SHARED_SECRET || 'troque_por_outro_segredo_so_do_bot_de_idade',

  // Bot de verificação de idade — agora roda dentro deste mesmo processo.
  AGE_BOT_DISCORD_TOKEN: process.env.AGE_BOT_DISCORD_TOKEN || 'COLE_O_TOKEN_DO_BOT_AQUI',
  AGE_BOT_CLIENT_ID: process.env.AGE_BOT_CLIENT_ID || '1506350438314934412',
  AGE_BOT_ROLE_ID: process.env.AGE_BOT_ROLE_ID || 'COLE_O_ROLE_ID_AQUI',
  ENTRAR_APP_ID: process.env.ENTRAR_APP_ID || 'COLE_O_APP_ID_DA_ENTRAR_API_AQUI',
};

const steam = new SteamAuth({
  realm: CONFIG.SITE_URL,
  returnUrl: `${CONFIG.SITE_URL}/auth/steam/callback`,
  apiKey: CONFIG.STEAM_API_KEY,
});

const DISCORD_API = 'https://discord.com/api/v10';

const pedidos = {};
const filaCreditos = [];
const jogadoresOnline = new Set();

// ============================================
// VINCULAÇÃO PERSISTENTE STEAMID <-> DISCORD ID
// Preenchido assim que alguém loga com os dois no site.
// Consumido pelo addon Lua via /gmod/verificados-idade.
// ============================================
const vinculos = {}; // { steamid64: { discordId, temCargo, verificadoEm, jaEnviadoAoJogo } }

// Preenchido pelo bot de verificação de idade do Discord (processo externo,
// separado deste backend). O bot NUNCA envia CPF, nome ou data de nascimento
// aqui — só o resultado final já calculado por ele: maiorDeIdade (true/false)
// vinculado ao Discord ID. Indexado por Discord ID porque é só isso que o
// bot conhece (ele não sabe o SteamID do jogador).
const verificacoesIdadePorDiscordId = {}; // { discordId: { maiorDeIdade, verificadoEm } }

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

// ============================================
// STEAM AUTH
// ============================================

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

    // Se o Discord já tinha sido feito antes (ordem inversa de login),
    // já grava/atualiza o vínculo persistente agora.
    await atualizarVinculoSeCompleto(req);

    res.redirect('/');
  } catch (error) {
    console.error('Erro na autenticação Steam:', error.message);
    res.redirect('/?erro=login_falhou');
  }
});

app.get('/auth/me', (req, res) => {
  if (req.session.steamUser) {
    res.json({ logado: true, ...req.session.steamUser });
  } else {
    res.json({ logado: false });
  }
});

// ============================================
// DISCORD AUTH + VERIFICAÇÃO DE CARGO
// ============================================

app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: CONFIG.DISCORD_CLIENT_ID,
    redirect_uri: `${CONFIG.SITE_URL}/auth/discord/callback`,
    response_type: 'code',
    scope: 'identify guilds.members.read',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?erro=discord_sem_code');

  try {
    const tokenResp = await axios.post(
      `${DISCORD_API}/oauth2/token`,
      new URLSearchParams({
        client_id: CONFIG.DISCORD_CLIENT_ID,
        client_secret: CONFIG.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${CONFIG.SITE_URL}/auth/discord/callback`,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenResp.data;

    const userResp = await axios.get(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    req.session.discordUser = {
      id: userResp.data.id,
      username: userResp.data.username,
      avatar: userResp.data.avatar
        ? `https://cdn.discordapp.com/avatars/${userResp.data.id}/${userResp.data.avatar}.png`
        : null,
    };

    // Se já tiver Steam logado nessa mesma sessão, já grava o vínculo
    // persistente agora mesmo (não precisa esperar uma compra).
    await atualizarVinculoSeCompleto(req);

    res.redirect('/');
  } catch (error) {
    console.error('Erro no callback Discord:', error.response?.data || error.message);
    res.redirect('/?erro=discord_falhou');
  }
});

app.get('/auth/discord/me', (req, res) => {
  if (req.session.discordUser) {
    res.json({ logado: true, ...req.session.discordUser });
  } else {
    res.json({ logado: false });
  }
});

async function temCargoExigido(discordUserId) {
  try {
    const resp = await axios.get(
      `${DISCORD_API}/guilds/${CONFIG.DISCORD_GUILD_ID}/members/${discordUserId}`,
      { headers: { Authorization: `Bot ${CONFIG.DISCORD_BOT_TOKEN}` } }
    );

    const roles = resp.data.roles || [];
    return roles.includes(CONFIG.DISCORD_REQUIRED_ROLE_ID);
  } catch (error) {
    if (error.response?.status === 404) {
      return false;
    }
    console.error('Erro ao verificar cargo Discord:', error.response?.data || error.message);
    return false;
  }
}

app.get('/discord/status-cargo', async (req, res) => {
  if (!req.session.discordUser) {
    return res.json({ logado: false, tem_cargo: false });
  }

  const temCargo = await temCargoExigido(req.session.discordUser.id);
  res.json({
    logado: true,
    username: req.session.discordUser.username,
    tem_cargo: temCargo,
  });
});

// ============================================
// VÍNCULO PERSISTENTE STEAMID <-> DISCORD (+ CARGO)
// Chamado sempre que Steam OU Discord acabou de logar, pra checar
// se agora os dois existem na sessão e já gravar/atualizar o vínculo.
// ============================================
async function atualizarVinculoSeCompleto(req) {
  if (!req.session.steamUser || !req.session.discordUser) return;

  const steamid = req.session.steamUser.steamid;
  const discordId = req.session.discordUser.id;

  // "Verificado" pode vir de duas fontes independentes: o cargo Discord
  // atribuído manualmente/por staff, OU o resultado que o bot de
  // verificação de idade já gravou nesse Discord ID. Basta uma bater.
  const temCargoDiscord = await temCargoExigido(discordId);
  const verificacaoBot = verificacoesIdadePorDiscordId[discordId];
  const temCargo = temCargoDiscord || (verificacaoBot?.maiorDeIdade === true);

  vinculos[steamid] = {
    discordId,
    temCargo,
    verificadoEm: Date.now(),
    jaEnviadoAoJogo: temCargo ? (vinculos[steamid]?.jaEnviadoAoJogo || false) : false,
  };
}

// ============================================
// LOGOUT
// ============================================

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ============================================
// GMOD BRIDGE (heartbeat, fila de créditos, verificação de idade)
// ============================================

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

// ============================================
// RESULTADO DO BOT DE VERIFICAÇÃO DE IDADE (Discord)
// Chamado pelo bot.js (processo externo, separado deste backend) depois
// que ele já calculou maior_de_idade via callback do serviço de
// verificação. Este backend NUNCA recebe CPF, nome ou data de nascimento
// — apenas o resultado final, já processado pelo bot.
// ============================================
app.post('/discord/resultado-verificacao-idade', (req, res) => {
  const { discordId, maiorDeIdade, secret } = req.body;

  if (secret !== CONFIG.AGE_BOT_SHARED_SECRET) {
    return res.status(401).json({ erro: 'Secret inválido' });
  }

  if (!discordId || typeof maiorDeIdade !== 'boolean') {
    return res.status(400).json({ erro: 'discordId e maiorDeIdade (boolean) são obrigatórios' });
  }

  registrarResultadoVerificacaoIdade(discordId, maiorDeIdade);
  res.json({ ok: true });
});

// Rota nova: addon consulta quem já verificou +18 e ainda não foi
// avisado ao jogo. Depois de entregar, marca jaEnviadoAoJogo=true
// (via /gmod/confirmar-idade) pra não reenviar sempre.
app.get('/gmod/verificados-idade', (req, res) => {
  const { secret } = req.query;

  if (secret !== CONFIG.GMOD_SHARED_SECRET) {
    return res.status(401).json({ erro: 'Secret inválido' });
  }

  const pendentesDeEnvio = Object.entries(vinculos)
    .filter(([_, v]) => v.temCargo && !v.jaEnviadoAoJogo)
    .map(([steamid, v]) => ({ steamid, discordId: v.discordId }));

  res.json({ verificados: pendentesDeEnvio });
});

app.post('/gmod/confirmar-idade', (req, res) => {
  const { steamid, secret } = req.body;

  if (secret !== CONFIG.GMOD_SHARED_SECRET) {
    return res.status(401).json({ erro: 'Secret inválido' });
  }

  if (vinculos[steamid]) {
    vinculos[steamid].jaEnviadoAoJogo = true;
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

// ============================================
// CUPONS
// ============================================

app.get('/validar-cupom/:codigo', (req, res) => {
  const codigo = req.params.codigo.trim().toUpperCase();
  const desconto = CUPONS[codigo];

  if (desconto === undefined) {
    return res.status(404).json({ valido: false, erro: 'Cupom inválido ou expirado.' });
  }

  res.json({ valido: true, codigo, desconto_percentual: desconto });
});

// ============================================
// PAINEL PESSOAL
// ============================================

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

// ============================================
// GERAR PIX
// ============================================

app.post('/gerar-pix', async (req, res) => {
  try {
    const { pacote, steamid, email, cupom } = req.body;

    if (!req.session.steamUser || req.session.steamUser.steamid !== steamid) {
      return res.status(401).json({ erro: 'É necessário fazer login com a Steam antes de comprar.' });
    }

    if (!req.session.discordUser) {
      return res.status(403).json({ erro: 'É necessário fazer login com o Discord antes de comprar.' });
    }

    const temCargo = await temCargoExigido(req.session.discordUser.id);
    if (!temCargo) {
      return res.status(403).json({ erro: 'Você precisa ter o cargo Verificado +18 no Discord para comprar.' });
    }

    // Já que confirmamos os dois logins + cargo aqui, garante que o
    // vínculo está gravado (cobre o caso de sessão antiga que nunca
    // passou pelo callback do Discord depois da Steam, por exemplo).
    await atualizarVinculoSeCompleto(req);

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

// ============================================
// STATUS DO PAGAMENTO
// ============================================

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

// ============================================
// WEBHOOK MERCADO PAGO
// ============================================

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

// ============================================
// BOT DE VERIFICAÇÃO DE IDADE (Discord) — roda no mesmo processo
// ============================================
// Fluxo: /verificar no Discord -> link da entrar.api.br -> usuário
// completa lá -> callback chega em /age-verify/callback (rota deste
// mesmo Express, abaixo) -> calcula maiorDeIdade -> atribui cargo no
// Discord -> grava resultado em verificacoesIdadePorDiscordId.
// Este processo NUNCA armazena CPF, nome ou data de nascimento —
// só o booleano final.

const filaAguardandoVerificacao = [];

const ageBotClient = new DiscordClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

async function registrarComandoVerificar() {
  const commands = [
    new SlashCommandBuilder()
      .setName('verificar')
      .setDescription('Verifica sua idade para acessar recursos +18 do servidor')
      .toJSON(),
  ];
  const rest = new REST({ version: '10' }).setToken(CONFIG.AGE_BOT_DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CONFIG.AGE_BOT_CLIENT_ID, CONFIG.DISCORD_GUILD_ID),
    { body: commands }
  );
  console.log('[AgeBot] Comando /verificar registrado');
}

ageBotClient.once('clientReady', async () => {
  console.log(`[AgeBot] Online como ${ageBotClient.user.tag}`);
  await registrarComandoVerificar();
});

ageBotClient.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'verificar') return;

  const userId = interaction.user.id;
  const member = interaction.member;

  if (member.roles.cache.has(CONFIG.AGE_BOT_ROLE_ID)) {
    await interaction.reply({ content: '✅ Você já está verificado como maior de 18 anos!', flags: 64 });
    return;
  }

  const itemFila = { userId, criadoEm: Date.now() };
  filaAguardandoVerificacao.push(itemFila);

  const urlVerificacao = `https://cpf.entrar.api.br/?appId=${CONFIG.ENTRAR_APP_ID}`;

  await interaction.reply({
    content:
      '🔐 **Verificação de Maioridade**\n\n' +
      `Clique no link abaixo, informe seu CPF e data de nascimento, e resolva o captcha:\n${urlVerificacao}\n\n` +
      '_Este servidor não recebe nem armazena seu CPF ou data de nascimento — apenas o resultado (maior/menor de idade)._\n' +
      '_Esse link expira em 10 minutos. Complete a verificação antes de pedir uma nova._',
    flags: 64,
  });

  setTimeout(() => {
    const idx = filaAguardandoVerificacao.indexOf(itemFila);
    if (idx !== -1) filaAguardandoVerificacao.splice(idx, 1);
  }, 10 * 60 * 1000);
});

function calcularIdade(dataNascimentoStr) {
  const nascimento = new Date(dataNascimentoStr);
  const hoje = new Date();
  let idade = hoje.getFullYear() - nascimento.getFullYear();
  const aindaNaoFezAniversario =
    hoje.getMonth() < nascimento.getMonth() ||
    (hoje.getMonth() === nascimento.getMonth() && hoje.getDate() < nascimento.getDate());
  if (aindaNaoFezAniversario) idade--;
  return idade;
}

// Registra o resultado final (booleano) — chamada tanto pelo callback
// abaixo quanto (se algum dia precisar) pela rota HTTP externa.
function registrarResultadoVerificacaoIdade(discordId, maiorDeIdade) {
  verificacoesIdadePorDiscordId[discordId] = {
    maiorDeIdade,
    verificadoEm: Date.now(),
  };

  for (const vinculo of Object.values(vinculos)) {
    if (vinculo.discordId === discordId) {
      vinculo.temCargo = maiorDeIdade;
      vinculo.jaEnviadoAoJogo = false;
    }
  }

  console.log(`[AgeBot] Discord ${discordId} => maiorDeIdade=${maiorDeIdade}`);
}

async function liberarAcessoDiscord(userId) {
  const guild = await ageBotClient.guilds.fetch(CONFIG.DISCORD_GUILD_ID);
  const member = await guild.members.fetch(userId);
  await member.roles.add(CONFIG.AGE_BOT_ROLE_ID);
  console.log(`[AgeBot] Cargo atribuído: ${userId}`);
}

// Callback do serviço de verificação. CPF/nome/nascimento passam por
// aqui só em memória volátil, dentro desta função — nunca são
// atribuídos a verificacoesIdadePorDiscordId nem persistidos em
// nenhum lugar do backend.
app.get('/age-verify/callback', async (req, res) => {
  const { session: sessionId } = req.query;

  if (!sessionId) {
    res.status(400).send('Requisição inválida: faltando session.');
    return;
  }

  const itemFila = filaAguardandoVerificacao.shift();
  if (!itemFila) {
    res.status(400).send('Nenhuma verificação pendente encontrada. Use /verificar novamente no Discord.');
    return;
  }

  try {
    const sessionRes = await fetch(`https://cpf.entrar.api.br/api/session/${sessionId}`);
    const sessionData = await sessionRes.json();

    if (!sessionData || sessionData.status !== true) {
      res.send('❌ Verificação falhou ou foi cancelada. Volte ao Discord e use /verificar novamente.');
      return;
    }

    const idade = calcularIdade(sessionData.dataNascimento);
    const userId = itemFila.userId;
    const maiorDeIdade = idade >= 18;

    registrarResultadoVerificacaoIdade(userId, maiorDeIdade);

    if (maiorDeIdade) {
      await liberarAcessoDiscord(userId);
      res.send('✅ Verificação aprovada! Você já pode voltar ao Discord — seu cargo foi liberado.');
    } else {
      res.send('🔒 Verificação não aprovada: idade mínima de 18 anos não confirmada. Você pode continuar jogando normalmente com Ryo.');
    }
  } catch (err) {
    console.error('[AgeBot] Erro ao consultar sessão:', err.message);
    res.status(500).send('Ocorreu um erro ao processar sua verificação. Tente novamente mais tarde.');
  }
});

if (CONFIG.AGE_BOT_DISCORD_TOKEN && CONFIG.AGE_BOT_DISCORD_TOKEN !== 'COLE_O_TOKEN_DO_BOT_AQUI') {
  ageBotClient.login(CONFIG.AGE_BOT_DISCORD_TOKEN);
} else {
  console.log('[AgeBot] AGE_BOT_DISCORD_TOKEN não configurado — bot de verificação de idade não foi iniciado.');
}

app.get('/', (req, res) => {
  res.send('Backend Loja de Gemas GMod está rodando');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});