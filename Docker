# Folosim o versiune stabila si usoara de Linux + Node.js
FROM node:20-bullseye-slim

# 1. Instalam FFmpeg (pt Caption/Watermark Remover) si dependente pt YT-DLP
RUN apt-get update && apt-get install -y \
    ffmpeg \
    wget \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# 2. Instalam cel mai nou yt-dlp direct de la sursa (ca sa evitam block-urile YouTube)
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# 3. Setam spatiul de lucru
WORKDIR /app

# 4. Copiem pachetele si instalam (inclusiv express, multer, openai etc)
COPY package*.json ./
RUN npm install

# 5. Copiem tot restul codului tau (server.js, etc.)
COPY . .

# 6. Cream folderul de downloads si ii dam permisiuni absolute
RUN mkdir -p downloads && chmod 777 downloads

# 7. Expuenm portul API-ului
EXPOSE 3000

# 8. Comanda de start
CMD ["node", "server.js"]