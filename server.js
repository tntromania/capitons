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

// CORS Permisiv pentru ca rutele stau la ele acasa
app.use(cors({ origin: '*' })); 
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 

// CONECTARE BAZA DE DATE CENTRALA
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Captions s-a conectat la MongoDB!'))
    .catch(err => console.error('❌ Eroare MongoDB:', err));

const UserSchema = new mongoose.Schema({
    googleId: String, email: String, name: String, picture: String,
    credits: { type: Number, default: 3 }
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

// LOGIN AUTONOM (Dar cu aceeasi BD)
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

// PROCESARE VIDEO
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
        const boxY = parseInt(req.body.boxY) || 70;
        const boxH = parseInt(req.body.boxH) || 20;
        
        const filterComplex = `[0:v]crop=iw:ih*${boxH}/100:0:ih*${boxY}/100,boxblur=25:25[b];[0:v][b]overlay=0:H*${boxY}/100`;

        exec(`ffmpeg -y -i "${inputPath}" -filter_complex "${filterComplex}" -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${outputPath}"`, async (error, stdout, stderr) => {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); 
            if (error) return res.status(500).json({ error: "Eroare FFmpeg la procesare." });

            user.credits -= 2; 
            await user.save();

            res.json({ status: 'ok', downloadUrl: `/download/clean_${videoId}.mp4`, creditsLeft: user.credits });
        });
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: e.message });
    }
});

app.get('/download/:filename', (req, res) => {
    const file = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(file)) res.download(file);
    else res.status(404).send('Fișier expirat.');
});

setInterval(() => {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const now = Date.now();
    files.forEach(file => {
        const filePath = path.join(DOWNLOAD_DIR, file);
        if (now - fs.statSync(filePath).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(filePath);
    });
}, 3600000); 

app.listen(PORT, () => console.log(`🚀 Caption Remover ruleaza pe portul ${PORT}!`));