const Rcon = require('rcon-srcds').default;

async function testar() {
  const rcon = new Rcon({
    host: '84.20.19.207',
    port: 58752,
    encoding: 'utf8',
    timeout: 8000,
  });

  try {
    console.log('Conectando...');
    await rcon.authenticate('TkRp_G3ms_Rc0n_2026!x9Q');
    console.log('Autenticado!');

    // Use seu próprio SteamID64 (idealmente o seu, pra você mesmo conferir no jogo)
    const resposta = await rcon.execute('takarp_gacha_givegems "76561198081074343" 50000');
    console.log('Resposta:', resposta);

    await rcon.disconnect();
  } catch (err) {
    console.error('ERRO:', err.message);
  }
}

testar();