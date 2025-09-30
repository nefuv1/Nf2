import { makeWASocket, DisconnectReason, useMultiFileAuthState, jidDecode } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import pino from 'pino';
import chalk from 'chalk';
import chokidar from 'chokidar';
import { loadPlugins, messageHandler } from './lib/handler.js';
import { printBanner, attachReplyFunction } from './lib/functions.js';

let isBotReady = false;
let botStartTime = 0;
const processedMessages = new Set();
const baileysLogger = pino({ level: 'silent' });

const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            ignore: 'pid,hostname,time,level',
            messageFormat: '{msg}'
        }
    }
});

const question = (text) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(text, (ans) => {
        rl.close();
        resolve(ans);
    }));
};

function startPluginWatcher(conn) {
    const pluginsDir = path.join(process.cwd(), 'plugins');
    if (!fs.existsSync(pluginsDir)) return;

    const watcher = chokidar.watch(pluginsDir, { ignored: /(^|[\/\\])\../, persistent: true, ignoreInitial: true });
    
    const reload = async (event, filePath) => {
        const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
        const eventColor = { '新しいプラグイン': chalk.green, 'プラグイン変更': chalk.yellow, 'プラグイン削除': chalk.red };
        const logLines = [
            chalk.bold.blue(`┌─「 プラグインリロード 」─ 🕒 ${time}`),
            chalk.blue(`│ ${eventColor[event](`⦿ ${event}`)}: ${chalk.cyan(path.basename(filePath))}`),
        ];
        const count = await loadPlugins(logger);
        logLines.push(chalk.blue(`└─「 ✔️ 」 Total Plugins: ${chalk.green(count)}`));
        logger.info(logLines.join('\n') + '\n');
    };

    watcher
        .on('add', (filePath) => reload('新しいプラグイン', filePath))
        .on('change', (filePath) => reload('プラグイン変更', filePath))
        .on('unlink', (filePath) => reload('プラグイン削除', filePath));
}

async function connectToWhatsApp() {
    botStartTime = Date.now();
    printBanner();
    
    const { state, saveCreds } = await useMultiFileAuthState('session');
    
    const conn = makeWASocket({
        logger: baileysLogger,
        auth: state,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    attachReplyFunction(conn);

    if (!conn.authState.creds.registered) {
        const phoneNumber = await question(chalk.cyan('› Masukkan nomor WhatsApp Anda (Contoh: 628123...): '));
        try {
            const code = await conn.requestPairingCode(phoneNumber);
            const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
            const logLines = [
                chalk.bold.magenta('\n┌─「 ✨ ペアリングコード ✨ 」'),
                chalk.magenta('│'),
                chalk.bold.green(`│  ›  ${formattedCode}`),
                chalk.magenta('│'),
                chalk.bold.magenta('└──────────────────────\n')
            ];
            console.log(logLines.join('\n'));
        } catch (e) {
            logger.error(chalk.red('Gagal meminta kode pairing. Coba lagi.'), e);
            process.exit(1);
        }
    };

    conn.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            const decode = jidDecode(jid) || {};
            return ((decode.user && decode.server && `${decode.user}@${decode.server}`) || jid);
        } else return jid;
    };

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "close") {
            isBotReady = false;
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            logger.warn(chalk.yellow(`Koneksi terputus: ${statusCode}, mencoba menghubungkan kembali...`));
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                logger.error(chalk.red('Koneksi terputus permanen. Hapus folder session dan mulai ulang.'));
            }
        } else if (connection === "open") {
            const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
            const pluginCount = await loadPlugins(logger);
            const logLines = [
                chalk.bold.green(`┌─「 接続完了 」─ 🕒 ${time}`),
                chalk.green(`│ ${chalk.cyan('User:')} ${conn.user.name || conn.user.id.split(':')[0]}`),
                chalk.green(`│ ${chalk.cyan('JID:')} ${conn.user.id.split(':')[0]}@s.whatsapp.net`),
                chalk.green('└────────── 「 🚀 」'),
                chalk.green(`✓ Nefufu berhasil memuat ${pluginCount} plugins.\n`)
            ];
            logger.info(logLines.join('\n'));
            isBotReady = true;
            startPluginWatcher(conn);
        }
    });

    conn.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        const messageTimestamp = (Number(m.messageTimestamp) * 1000) || Date.now();

        if (!isBotReady || !m.message || messageTimestamp < botStartTime) {
            return;
        }

        const body = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const prefix = /^[./!#]/.test(body) ? body.match(/^[./!#]/)[0] : '/';

        if (m.key.fromMe && !body.startsWith(prefix)) {
            return;
        }
        
        if (processedMessages.has(m.key.id)) return;
        processedMessages.add(m.key.id);
        setTimeout(() => processedMessages.delete(m.key.id), 60000);

        m.chat = m.key.remoteJid;
        m.isGroup = m.chat.endsWith('@g.us');
        m.sender = conn.decodeJid(m.key.participant || m.key.remoteJid || m.chat);
        
        if (body) {
            const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
            const senderName = m.pushName || 'Tidak Diketahui';
            
            const logLines = [chalk.bold.magenta(`┌─「 受信メッセージ 」─ 🕒 ${time}`)];
            if (m.isGroup) {
                const groupMeta = await conn.groupMetadata(m.chat);
                logLines.push(chalk.magenta(`│ ${chalk.green('Grup:')} ${groupMeta.subject}`));
                logLines.push(chalk.magenta(`│ ${chalk.cyan('Pengirim:')} ${senderName} (${m.sender.split('@')[0]})`));
            } else {
                logLines.push(chalk.magenta(`│ ${chalk.cyan('Dari:')} ${senderName}`));
            }
            logLines.push(chalk.magenta(`│ ${chalk.whiteBright('Pesan:')} ${body}`));
            logLines.push(chalk.bold.magenta('└────────────────────── 「 ✔️ 」\n'));
            logger.info(logLines.join('\n'));
        }
        
        try {
            await messageHandler(conn, m, logger);
        } catch (e) {
            logger.error(chalk.red("Error pada handler utama:\n"), e);
        }
    });
    
    process.on('uncaughtException', (err, origin) => {
        logger.fatal(`UNCAUGHT EXCEPTION AT: ${origin}`, err);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason, promise) => {
        logger.fatal('UNHANDLED REJECTION AT:', promise, 'reason:', reason);
        process.exit(1);
    });
};

connectToWhatsApp();
