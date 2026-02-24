require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const multer = require('multer'); 

const app = express();
const PORT = process.env.PORT || 3000;

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const upload = multer({ dest: DOWNLOAD_DIR, limits: { fileSize: 100 * 1024 * 1024 } });

// FIX CORS
app.use(cors({ origin: '*' })); 
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 

// DB (Se conecteaza la EXACT aceeasi baza de date ca Downloader-ul)
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Captions s-a conectat la baza de date centrala MongoDB!'))
    .catch(err => console.error('❌ Eroare MongoDB:', err));

const UserSchema = new mongoose.Schema({
    googleId: String, email: String, name: String, picture: String, credits: { type: Number, default: 3 }
});
const User = mongoose.model('User', UserSchema);

const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Trebuie să fii logat!" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (e) { return res.status(401).json({ error: "Sesiune expirată." }); }
};

// ==========================================
// RUTE AUTH - Acum face login local, dar scrie in BD Centrala!
// ==========================================
app.post('/api/auth/google', async (req, res) => {
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: req.body.credential, audience: process.env.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        
        let user = await User.findOne({ googleId: payload.sub });
        if (!user) {
            user = new User({ googleId: payload.sub, email: payload.email, name: payload.name, picture: payload.picture, credits: 3 });
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
// ENDPOINT CAPTION REMOVER (FFMPEG ULTRA - FIXED)
// ==========================================
app.post('/api/remove-caption', authenticate, upload.single('video'), async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (user.credits < 2) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: "Cost: 2 Credite. Fonduri insuficiente." });
        }
        if (!req.file) return res.status(400).json({ error: "Video lipsă." });

        const inputPath = req.file.path;
        const videoId = Date.now();
        const outputPath = path.join(DOWNLOAD_DIR, `clean_${videoId}.mp4`);
        
        // Preluam datele din frontend
        const boxY = parseInt(req.body.boxY) || 70; 
        const boxH = parseInt(req.body.boxH) || 20; 
        const method = req.body.method || 'blur';

        // 1. Aflam dimensiunile reale ale video-ului pentru a calcula Pixelii exacti (rezolva eroarea 'ih*70/100')
        exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${inputPath}"`, (probeErr, probeOut) => {
            if (probeErr) {
                 if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                 return res.status(500).json({ error: "Eroare la analiza metadatelor video-ului." });
            }

            // ffprobe returneaza ceva gen "1080x1920\n"
            const [width, height] = probeOut.trim().split('x').map(Number);
            
            // 2. Calculam in PIXELI EXACȚI. Asta este "glonț-proof" pt FFmpeg.
            let pixelY = Math.floor((boxY / 100) * height);
            let pixelH = Math.floor((boxH / 100) * height);
            
            // Setam zona de X (stanga-dreapta) la maxim posibil, dar lasand o marja de 4 pixeli 
            // delogo are nevoie de pixeli pe margine din care sa "imprumute" culorile.
            let pixelX = 4; 
            let pixelW = width - 8; 

            // Siguranta anti-crash: masca nu are voie sa iasa in afara video-ului.
            if (pixelY + pixelH >= height) {
                pixelH = height - pixelY - 4; // lasam 4px la baza jos
            }
            if (pixelY < 4) pixelY = 4;

            let filterString = "";
            let filterFlag = "";

            if (method === 'inpaint') {
                // ULTRA INPAINTING (Delogo)
                // band=20 este raza de pixeli de pe care ia mostre. Cu cat e mai mare, cu atat topeste textul mai bine in fundal.
                filterFlag = "-vf";
                filterString = `delogo=x=${pixelX}:y=${pixelY}:w=${pixelW}:h=${pixelH}:band=20`;
            } else {
                // ULTRA BLUR
                // boxblur=60:60 -> o zona de blur enorma, mascheaza orice urma de text ascutit.
                filterFlag = "-filter_complex";
                filterString = `[0:v]crop=${pixelW}:${pixelH}:${pixelX}:${pixelY},boxblur=60:60[b];[0:v][b]overlay=${pixelX}:${pixelY}`;
            }
            
            // 3. Comanda finala: 
            // -map 0:v (Ia video-ul)
            // -map 0:a? (Copiaza sunetul DOAR daca exista. Asta opreste erorile pt video-uri mute).
            const ffmpegCommand = `ffmpeg -y -i "${inputPath}" ${filterFlag} "${filterString}" -map 0:v -map 0:a? -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${outputPath}"`;

            exec(ffmpegCommand, async (error, stdout, stderr) => {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); 
                
                if (error) {
                    console.error("FFMPEG ERROR:", stderr);
                    // Daca totesi mai pica, returnam ultimele linii de pe Linux in Pop-Up sa stim clar!
                    return res.status(500).json({ error: "Eroare la randare video: " + stderr.split('\n').slice(-3).join(' ') });
                }

                user.credits -= 2; 
                await user.save();

                res.json({ status: 'ok', downloadUrl: `/download/clean_${videoId}.mp4`, creditsLeft: user.credits });
            });
        });

    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: e.message });
    }
});

app.get('/download/:filename', (req, res) => {
    const file = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(file)) res.download(file); else res.status(404).send('Expirat.');
});

app.listen(PORT, () => console.log(`🚀 Captions ruleaza pe ${PORT}!`));