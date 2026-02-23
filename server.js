require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const multer = require('multer'); // PENTRU UPLOAD FISIERE VIDEO

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Setari VPS (Căile vin automat din Docker acum)
const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// Configurare Multer pentru upload temporar
const upload = multer({ 
    dest: DOWNLOAD_DIR,
    limits: { fileSize: 100 * 1024 * 1024 } // Limita de 100MB per fisier
});

app.use(cors({ origin: '*' }));
app.use(express.json());

// ==========================================
// BAZA DE DATE & SCHEME
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Conectat la MongoDB!'))
    .catch(err => console.error('❌ Eroare MongoDB:', err));

const UserSchema = new mongoose.Schema({
    googleId: String, email: String, name: String, picture: String,
    credits: { type: Number, default: 3 },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const CacheSchema = new mongoose.Schema({
    videoId: String, originalText: String, translatedText: String,
    createdAt: { type: Date, expires: 86400, default: Date.now }
});
const VideoCache = mongoose.model('VideoCache', CacheSchema);

// Proxies
const PROXY_URL = `http://7e96441a0204cbbea090:31a09abfc490dcd7@gw.dataimpulse.com:823`;
const proxyArg = `--proxy "${PROXY_URL}"`;
const bypassArgs = `--force-ipv4 --extractor-args "youtube:player_client=android,web" --no-warnings`;

// ==========================================
// MIDDLEWARE AUTH
// ==========================================
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Trebuie să fii logat!" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (e) {
        return res.status(401).json({ error: "Sesiune expirată." });
    }
};

// ==========================================
// 1. RUTE AUTHENTIFICARE
// ==========================================
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        const ticket = await googleClient.verifyIdToken({
            idToken: credential, audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        
        let user = await User.findOne({ googleId: payload.sub });
        if (!user) {
            user = new User({
                googleId: payload.sub, email: payload.email,
                name: payload.name, picture: payload.picture, credits: 3
            });
            await user.save();
        }

        const sessionToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token: sessionToken, user: { name: user.name, picture: user.picture, credits: user.credits } });
    } catch (error) { res.status(400).json({ error: "Eroare Google" }); }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    const user = await User.findById(req.userId);
    res.json({ user: { name: user.name, picture: user.picture, credits: user.credits } });
});

// ==========================================
// 2. YT DOWNLOADER & TRANSLATOR
// ==========================================
const downloadVideo = (url, outputPath) => {
    return new Promise((resolve, reject) => {
        const command = `"${YTDLP_PATH}" ${proxyArg} ${bypassArgs} -f "b[ext=mp4]/best" -o "${outputPath}" --no-check-certificates --no-playlist "${url}"`;
        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 180000 }, (error) => {
            if (error) reject(new Error("Serverul YouTube a refuzat conexiunea.")); else resolve();
        });
    });
};

const getTranscriptAndTranslation = async (url) => {
    return new Promise((resolve) => {
        const command = `"${YTDLP_PATH}" ${proxyArg} ${bypassArgs} --write-auto-sub --skip-download --sub-lang en,ro --convert-subs vtt --output "${path.join(DOWNLOAD_DIR, 'temp_%(id)s')}" "${url}"`;
        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 60000 }, async (err) => {
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('temp_') && f.endsWith('.vtt'));
            let originalText = "";
            if (files.length === 0) return resolve({ original: "Nu s-a găsit subtitrare.", translated: "Nu există text." });
            
            const vttPath = path.join(DOWNLOAD_DIR, files[0]);
            let content = fs.readFileSync(vttPath, 'utf8');
            content = content.replace(/WEBVTT/gi, '').replace(/Kind:[^\n]+/gi, '').replace(/Language:[^\n]+/gi, '')
                .replace(/align:[^\n]+/gi, '').replace(/position:[^\n]+/gi, '')
                .replace(/(\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*)/g, '')
                .replace(/<[^>]*>/g, '').replace(/\[Music\]/gi, '').replace(/\[Muzică\]/gi, '');

            originalText = [...new Set(content.split('\n').map(l => l.trim()).filter(l => l.length > 2))].join(' ');
            fs.unlinkSync(vttPath);

            try {
                const completion = await openai.chat.completions.create({
                    messages: [ { role: "system", content: "Tradu textul în română. Doar traducerea." }, { role: "user", content: originalText.substring(0, 10000) } ],
                    model: "gpt-4o-mini", 
                });
                resolve({ original: originalText, translated: completion.choices[0].message.content });
            } catch (e) { resolve({ original: originalText, translated: "Eroare AI: " + e.message }); }
        });
    });
};

app.post('/api/process-yt', authenticate, async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    const user = await User.findById(req.userId);
    if (user.credits <= 0) return res.status(403).json({ error: "Nu mai ai credite!" });

    if (url.includes('/shorts/')) url = url.replace('/shorts/', '/watch?v=').split('&')[0].split('?feature')[0];
    const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([^&?]+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : Date.now();
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

    try {
        const cachedData = await VideoCache.findOne({ videoId });
        if (cachedData && fs.existsSync(outputPath)) {
            user.credits -= 1; await user.save();
            return res.json({ status: 'ok', downloadUrl: `/download/${videoId}.mp4`, originalText: cachedData.originalText, translatedText: cachedData.translatedText, creditsLeft: user.credits });
        }

        const [aiData] = await Promise.all([ getTranscriptAndTranslation(url), downloadVideo(url, outputPath) ]);
        await VideoCache.create({ videoId, originalText: aiData.original, translatedText: aiData.translated });
        user.credits -= 1; await user.save();

        res.json({ status: 'ok', downloadUrl: `/download/${videoId}.mp4`, originalText: aiData.original, translatedText: aiData.translated, creditsLeft: user.credits });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 3. CAPTION & WATERMARK REMOVER (NOU - FFMPEG)
// ==========================================
app.post('/api/remove-caption', authenticate, upload.single('video'), async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (user.credits < 2) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: "Nu ai destule credite (Cost: 2 Credite)." });
        }
        if (!req.file) return res.status(400).json({ error: "Nu a fost detectat niciun fișier video." });

        const inputPath = req.file.path;
        const videoId = Date.now();
        const outputPath = path.join(DOWNLOAD_DIR, `clean_${videoId}.mp4`);
        const { position } = req.body; // 'bottom', 'center', sau 'tiktok'

        let filterComplex = "";
        if (position === "bottom") {
            // Blureaza zona de jos 20%
            filterComplex = `[0:v]crop=iw:ih*0.20:0:ih*0.80,boxblur=20:20[b];[0:v][b]overlay=0:H*0.80`;
        } else if (position === "center") {
            // Blureaza zona de centru (Meme)
            filterComplex = `[0:v]crop=iw:ih*0.25:0:ih*0.35,boxblur=20:20[b];[0:v][b]overlay=0:H*0.35`;
        } else if (position === "tiktok") {
            // Elimina logo dreapta jos + stanga sus
            filterComplex = `[0:v]delogo=x=20:y=20:w=W/4:h=H/10,delogo=x=W-W/4-20:y=H-H/10-20:w=W/4:h=H/10`;
        } else {
            filterComplex = `[0:v]crop=iw:ih*0.20:0:ih*0.80,boxblur=20:20[b];[0:v][b]overlay=0:H*0.80`;
        }

        // FFMPEG Command: ultra-rapid pentru SaaS
        const ffmpegCommand = `ffmpeg -y -i "${inputPath}" -filter_complex "${filterComplex}" -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${outputPath}"`;

        exec(ffmpegCommand, async (error, stdout, stderr) => {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); // Stergem fisierul sursa

            if (error) {
                console.error("FFMPEG ERROR:", stderr);
                return res.status(500).json({ error: "Eroare la procesarea video-ului." });
            }

            user.credits -= 2; // Taxam userul
            await user.save();

            res.json({
                status: 'ok',
                downloadUrl: `/download/clean_${videoId}.mp4`,
                creditsLeft: user.credits
            });
        });

    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// ENDPOINT DESCARCARE FISIERE
// ==========================================
app.get('/download/:filename', (req, res) => {
    const file = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(file)) res.download(file);
    else res.status(404).send('Fișier expirat.');
});

// CRON: Sterge fisierele vechi (24h)
setInterval(() => {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const now = Date.now();
    files.forEach(file => {
        const filePath = path.join(DOWNLOAD_DIR, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(filePath);
    });
}, 3600000); 

app.listen(PORT, () => console.log(`🚀 API Viralio rulează pe Docker (FFmpeg + YTDLP ready)!`));