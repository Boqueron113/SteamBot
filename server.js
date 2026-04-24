// ═══════════════════════════════════════════════════════════════════════════
// STEAM DEALS BOT v3 — Discord Slash Commands — rebuild forzado
// Comandos: /añadir /misteam /listar /buscar /ofertas /gratis
// ═══════════════════════════════════════════════════════════════════════════

const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ─────────────────────────────────────────────────────────────────
const DISCORD_TOKEN    = process.env.DISCORD_TOKEN;     // token del bot
const DISCORD_CLIENT_ID= process.env.DISCORD_CLIENT_ID;// application ID
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID; // ID de tu servidor
const MIN_DISCOUNT     = parseInt(process.env.MIN_DISCOUNT || "20");
const CHECK_INTERVAL   = 60 * 60 * 1000; // scan cada hora
const ALERT_CHANNEL_ID = process.env.ALERT_CHANNEL_ID; // canal de alertas

// ── STATE ──────────────────────────────────────────────────────────────────
const notified    = new Set();
const customGames = new Map(); // appId → { name, addedBy, userId }
const userSteamIds= new Map(); // discordUserId → steamId64
const dealHistory = [];

// ── DISCORD CLIENT ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ── SLASH COMMANDS ─────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('añadir')
    .setDescription('Añade un juego de Steam para monitorear')
    .addStringOption(o => o.setName('url').setDescription('URL del juego en Steam (store.steampowered.com/app/XXXX)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('misteam')
    .setDescription('Registra tu Steam ID para monitorear tu wishlist')
    .addStringOption(o => o.setName('steamid').setDescription('Tu Steam ID64 (ej: 76561198xxxxxxxxx)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('listar')
    .setDescription('Ver todos los juegos monitoreados'),

  new SlashCommandBuilder()
    .setName('eliminar')
    .setDescription('Eliminar un juego de la lista')
    .addStringOption(o => o.setName('url').setDescription('URL del juego en Steam').setRequired(true)),

  new SlashCommandBuilder()
    .setName('buscar')
    .setDescription('Buscar el precio actual de un juego')
    .addStringOption(o => o.setName('url').setDescription('URL del juego en Steam').setRequired(true)),

  new SlashCommandBuilder()
    .setName('ofertas')
    .setDescription('Ver las mejores ofertas de Steam ahora mismo'),

  new SlashCommandBuilder()
    .setName('gratis')
    .setDescription('Ver juegos gratuitos disponibles ahora en Steam'),

  new SlashCommandBuilder()
    .setName('wishlist')
    .setDescription('Ver ofertas en tu wishlist de Steam'),

  new SlashCommandBuilder()
    .setName('ayuda')
    .setDescription('Ver todos los comandos disponibles'),
];

// Registrar comandos al arrancar
async function registerCommands() {
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) return;
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('[DISCORD] Slash commands registrados');
  } catch (e) {
    console.log(`[DISCORD] Error registrando commands: ${e.message}`);
  }
}

// ── STEAM API ──────────────────────────────────────────────────────────────
function extractAppId(url) {
  const match = url.match(/\/app\/(\d+)/);
  return match ? match[1] : null;
}

async function getAppPrice(appId) {
  try {
    const { data } = await axios.get(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=es&l=es`,
      { timeout: 8000 }
    );
    const app = data?.[appId];
    if (!app?.success || !app?.data) return null;
    const d = app.data;
    if (d.is_free) return {
      appId, name: d.name,
      originalPrice: 0, finalPrice: 0, discount: 100,
      url: `https://store.steampowered.com/app/${appId}`,
      image: d.header_image, free: true,
    };
    if (!d.price_overview) return { appId, name: d.name, originalPrice: 0, finalPrice: 0, discount: 0, url: `https://store.steampowered.com/app/${appId}`, image: d.header_image, free: true };
    const p = d.price_overview;
    return {
      appId, name: d.name,
      originalPrice: p.initial, finalPrice: p.final,
      discount: p.discount_percent,
      url: `https://store.steampowered.com/app/${appId}`,
      image: d.header_image, free: false,
    };
  } catch { return null; }
}

async function getFeaturedDeals() {
  try {
    const { data } = await axios.get('https://store.steampowered.com/api/featuredcategories?cc=es&l=es', { timeout: 10000 });
    const items = [...(data?.specials?.items || []), ...(data?.top_sellers?.items || [])];
    return items
      .filter((g, i, arr) => g.discount_percent >= MIN_DISCOUNT && arr.findIndex(x => x.id === g.id) === i)
      .slice(0, 10)
      .map(g => ({
        appId: String(g.id), name: g.name,
        originalPrice: g.original_price, finalPrice: g.final_price,
        discount: g.discount_percent,
        url: `https://store.steampowered.com/app/${g.id}`,
        image: g.large_capsule_image || g.header_image,
      }));
  } catch { return []; }
}

async function getFreeGames() {
  try {
    const { data } = await axios.get('https://store.steampowered.com/api/featuredcategories?cc=es&l=es', { timeout: 10000 });
    const items = [...(data?.specials?.items || [])];
    return items
      .filter(g => g.final_price === 0 && g.original_price > 0)
      .map(g => ({
        appId: String(g.id), name: g.name,
        originalPrice: g.original_price, finalPrice: 0, discount: 100,
        url: `https://store.steampowered.com/app/${g.id}`,
        image: g.large_capsule_image || g.header_image,
      }));
  } catch { return []; }
}

async function getUserWishlist(steamId) {
  try {
    const { data } = await axios.get(
      `https://store.steampowered.com/wishlist/profiles/${steamId}/wishlistdata/?p=0`,
      { timeout: 10000 }
    );
    return Object.entries(data)
      .map(([appId, info]) => ({
        appId, name: info.name,
        originalPrice: info.subs?.[0]?.price || 0,
        finalPrice: info.subs?.[0]?.price || 0,
        discount: info.subs?.[0]?.discount_pct || 0,
        url: `https://store.steampowered.com/app/${appId}`,
        image: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
      }))
      .filter(g => g.discount >= MIN_DISCOUNT);
  } catch { return []; }
}

// ── EMBEDS ─────────────────────────────────────────────────────────────────
function dealEmbed(g) {
  const isFree = g.finalPrice === 0;
  return new EmbedBuilder()
    .setTitle(isFree ? `🆓 GRATIS · ${g.name}` : `🔥 -${g.discount}% · ${g.name}`)
    .setURL(g.url)
    .setColor(isFree ? 0x00e676 : g.discount >= 75 ? 0xff4444 : g.discount >= 50 ? 0xff9944 : 0xffd700)
    .setThumbnail(g.image)
    .addFields(
      { name: "Precio", value: isFree ? "**GRATIS** 🎉" : `~~€${(g.originalPrice/100).toFixed(2)}~~ → **€${(g.finalPrice/100).toFixed(2)}**`, inline: true },
      { name: "Descuento", value: `**-${g.discount}%**`, inline: true },
    )
    .setFooter({ text: `Steam Deals Bot · ${new Date().toLocaleString("es-ES")}` });
}

// ── COMMAND HANDLERS ───────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user } = interaction;
  await interaction.deferReply();

  // /añadir <url>
  if (commandName === 'añadir') {
    const url   = interaction.options.getString('url');
    const appId = extractAppId(url);
    if (!appId) return interaction.editReply('❌ URL inválida. Usa una URL de Steam como: `https://store.steampowered.com/app/1245620`');

    const game = await getAppPrice(appId);
    if (!game) return interaction.editReply('❌ Juego no encontrado en Steam.');

    customGames.set(appId, { name: game.name, addedBy: user.username, userId: user.id, addedAt: Date.now() });

    const embed = new EmbedBuilder()
      .setTitle(`➕ ${game.name} añadido`)
      .setURL(game.url)
      .setColor(0x64b5f6)
      .setThumbnail(game.image)
      .setDescription(`Añadido por **${user.username}**\nTe avisaré cuando baje **-${MIN_DISCOUNT}%** o más.`)
      .addFields(
        { name: "Precio actual", value: game.finalPrice === 0 ? '**GRATIS** 🎉' : `€${(game.finalPrice/100).toFixed(2)}`, inline: true },
        { name: "Descuento", value: game.discount > 0 ? `-${game.discount}%` : 'Sin descuento', inline: true },
      );

    return interaction.editReply({ embeds: [embed] });
  }

  // /misteam <steamid>
  if (commandName === 'misteam') {
    const steamId = interaction.options.getString('steamid');
    if (!/^\d{17}$/.test(steamId)) {
      return interaction.editReply('❌ Steam ID inválido. Debe ser un número de 17 dígitos.\n💡 Encuéntralo en: steamcommunity.com/id/TU_USUARIO → pulsa "Editar perfil" → Steam ID.');
    }
    userSteamIds.set(user.id, steamId);
    const wishlist = await getUserWishlist(steamId);
    const embed = new EmbedBuilder()
      .setTitle('✅ Steam ID registrado')
      .setColor(0x00e676)
      .setDescription(`Tu Steam ID **${steamId}** fue vinculado.\nTu wishlist tiene **${wishlist.length}** juegos con descuento ≥${MIN_DISCOUNT}% ahora mismo.`)
      .setFooter({ text: 'Usa /wishlist para ver las ofertas actuales' });
    return interaction.editReply({ embeds: [embed] });
  }

  // /listar
  if (commandName === 'listar') {
    if (customGames.size === 0) return interaction.editReply('📋 No hay juegos en la lista todavía. Usa `/añadir` para añadir uno.');
    const lines = Array.from(customGames.entries())
      .map(([id, g]) => `• [${g.name}](https://store.steampowered.com/app/${id}) — añadido por **${g.addedBy}**`)
      .join('\n');
    const embed = new EmbedBuilder()
      .setTitle(`📋 Juegos monitoreados (${customGames.size})`)
      .setColor(0x64b5f6)
      .setDescription(lines)
      .setFooter({ text: `Aviso cuando bajan -${MIN_DISCOUNT}% o son gratis` });
    return interaction.editReply({ embeds: [embed] });
  }

  // /eliminar <url>
  if (commandName === 'eliminar') {
    const url   = interaction.options.getString('url');
    const appId = extractAppId(url);
    if (!appId || !customGames.has(appId)) return interaction.editReply('❌ Juego no encontrado en la lista.');
    const name = customGames.get(appId).name;
    customGames.delete(appId);
    return interaction.editReply(`✅ **${name}** eliminado de la lista.`);
  }

  // /buscar <url>
  if (commandName === 'buscar') {
    const url   = interaction.options.getString('url');
    const appId = extractAppId(url);
    if (!appId) return interaction.editReply('❌ URL inválida.');
    const game = await getAppPrice(appId);
    if (!game) return interaction.editReply('❌ Juego no encontrado.');
    return interaction.editReply({ embeds: [dealEmbed(game)] });
  }

  // /ofertas
  if (commandName === 'ofertas') {
    const deals = await getFeaturedDeals();
    if (deals.length === 0) return interaction.editReply('😔 No hay ofertas destacadas ahora mismo.');
    const top5  = deals.slice(0, 5);
    const embed = new EmbedBuilder()
      .setTitle('🔥 Mejores ofertas de Steam ahora')
      .setColor(0xff9944)
      .setDescription(top5.map(g => `• **[${g.name}](${g.url})** — ~~€${(g.originalPrice/100).toFixed(2)}~~ → **€${(g.finalPrice/100).toFixed(2)}** (-${g.discount}%)`).join('\n'))
      .setFooter({ text: `Descuento mínimo: ${MIN_DISCOUNT}% · ${deals.length} ofertas encontradas` });
    return interaction.editReply({ embeds: [embed] });
  }

  // /gratis
  if (commandName === 'gratis') {
    const free = await getFreeGames();
    if (free.length === 0) return interaction.editReply('😔 No hay juegos gratis temporales ahora mismo. ¡Vuelve a intentarlo pronto!');
    const embeds = free.slice(0, 5).map(g => dealEmbed(g));
    return interaction.editReply({ content: '🆓 **Juegos GRATIS ahora en Steam:**', embeds });
  }

  // /wishlist
  if (commandName === 'wishlist') {
    const steamId = userSteamIds.get(user.id);
    if (!steamId) return interaction.editReply('❌ No tienes Steam ID registrado. Usa `/misteam <tu-steam-id>` primero.');
    const deals = await getUserWishlist(steamId);
    if (deals.length === 0) return interaction.editReply(`😔 Ningún juego de tu wishlist tiene descuento ≥${MIN_DISCOUNT}% ahora mismo.`);
    const embed = new EmbedBuilder()
      .setTitle(`🎮 Ofertas en tu wishlist (${deals.length})`)
      .setColor(0x1b2838)
      .setDescription(deals.slice(0, 8).map(g => `• **[${g.name}](${g.url})** — -${g.discount}% → **€${(g.finalPrice/100).toFixed(2)}**`).join('\n'))
      .setFooter({ text: `Steam ID: ${steamId}` });
    return interaction.editReply({ embeds: [embed] });
  }

  // /ayuda
  if (commandName === 'ayuda') {
    const embed = new EmbedBuilder()
      .setTitle('🎮 Steam Deals Bot — Comandos')
      .setColor(0x1b2838)
      .addFields(
        { name: '/añadir <url>',  value: 'Añade un juego para monitorear' },
        { name: '/eliminar <url>',value: 'Elimina un juego de la lista' },
        { name: '/listar',        value: 'Ver todos los juegos monitoreados' },
        { name: '/buscar <url>',  value: 'Ver precio actual de un juego' },
        { name: '/misteam <id>',  value: 'Registra tu Steam ID para alertas de wishlist' },
        { name: '/wishlist',      value: 'Ver ofertas en tu wishlist ahora mismo' },
        { name: '/ofertas',       value: 'Ver mejores ofertas de Steam ahora' },
        { name: '/gratis',        value: 'Ver juegos gratuitos disponibles ahora' },
      )
      .setFooter({ text: `Aviso automático cuando un juego baja -${MIN_DISCOUNT}% o es gratis` });
    return interaction.editReply({ embeds: [embed] });
  }
});

// ── SCAN AUTOMÁTICO ────────────────────────────────────────────────────────
async function sendAlert(game) {
  const key = `${game.appId}_${game.discount}`;
  if (notified.has(key)) return;
  notified.add(key);
  dealHistory.unshift({ ...game, time: Date.now() });
  if (dealHistory.length > 100) dealHistory.pop();

  const channel = client.channels.cache.get(ALERT_CHANNEL_ID);
  if (!channel) return;

  await channel.send({ embeds: [dealEmbed(game)] });
  console.log(`[ALERT] ${game.name} -${game.discount}%`);
}

async function scan() {
  console.log(`\n[SCAN] ${new Date().toLocaleString("es-ES")}`);

  // Juegos gratis
  const free = await getFreeGames();
  for (const g of free) { await sendAlert(g); await new Promise(r => setTimeout(r, 500)); }

  // Ofertas destacadas
  const featured = await getFeaturedDeals();
  for (const g of featured) { await sendAlert(g); await new Promise(r => setTimeout(r, 300)); }

  // Juegos añadidos por usuarios
  for (const [appId] of customGames) {
    const g = await getAppPrice(appId);
    if (g && (g.discount >= MIN_DISCOUNT || g.finalPrice === 0)) await sendAlert(g);
    await new Promise(r => setTimeout(r, 500));
  }

  // Wishlists de usuarios registrados
  for (const [discordId, steamId] of userSteamIds) {
    const deals = await getUserWishlist(steamId);
    for (const g of deals) { await sendAlert(g); await new Promise(r => setTimeout(r, 300)); }
  }

  console.log(`[SCAN] Completo — ${dealHistory.length} deals en historial`);
}

// ── START ──────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[DISCORD] Bot conectado como ${client.user.tag}`);
  await registerCommands();
  setTimeout(scan, 5000);
  setInterval(scan, CHECK_INTERVAL);
});

if (DISCORD_TOKEN) {
  client.login(DISCORD_TOKEN);
} else {
  console.log('⚠️  Sin DISCORD_TOKEN — modo solo API');
}

// ── EXPRESS STATUS ─────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status:       '✅ Steam Deals Bot activo',
  min_discount: `${MIN_DISCOUNT}%`,
  games:        customGames.size,
  users:        userSteamIds.size,
  deals_today:  dealHistory.filter(d => Date.now() - d.time < 86400000).length,
  last_deals:   dealHistory.slice(0, 5),
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎮 Steam Deals Bot — puerto ${PORT}`));
