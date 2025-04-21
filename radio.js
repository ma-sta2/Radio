const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const MUSIC_DIR = path.join(__dirname, 'music');
const REPORTS_FILE = path.join(__dirname, 'reports.json');
let trackQueue = []; // Очередь треков
let currentTrackIndex = 0; // Индекс текущего трека
let startTime = 0;
let trackDuration = 0; // Длительность трека
let likes = 0;
let skipTimeout = null; // Таймаут для пропуска трека

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

let onlineClients = 0;

// Перемешивание массива (алгоритм Фишера-Йетса)
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Инициализация очереди треков
function initializeTrackQueue() {
    const files = fs.readdirSync(MUSIC_DIR).filter(file => file.endsWith('.mp3'));
    trackQueue = shuffle(files); // Перемешиваем список треков
    currentTrackIndex = 0; // Сбрасываем индекс
}

// Получение следующего трека
function getNextTrack() {
    const track = trackQueue[currentTrackIndex];
    currentTrackIndex++;
    // Если дошли до конца очереди, начинаем новый цикл
    if (currentTrackIndex >= trackQueue.length) {
        initializeTrackQueue(); // Перемешиваем заново
    }
    return track;
}

// Получение длительности трека
function getTrackDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata.format.duration;
            resolve(duration);
        });
    });
}

// Запуск трека
async function playTrack() {
    currentTrack = getNextTrack();
    const trackPath = path.join(MUSIC_DIR, currentTrack);

    try {
        trackDuration = await getTrackDuration(trackPath);
        startTime = Date.now();
        likes = 0;
        console.log(`Playing track: ${currentTrack} (${trackDuration.toFixed(2)}s)`);
        broadcastTrackInfo();

        // Устанавливаем таймер для следующего трека
        skipTimeout = setTimeout(playTrack, trackDuration * 1000);
    } catch (err) {
        console.error('Error getting track duration:', err);
        // Если ошибка, пытаемся проиграть следующий трек
        skipTimeout = setTimeout(playTrack, 5000);
    }
}

// Пропуск трека
function skipTrack() {
    console.log('Skipping current track...');
    clearTimeout(skipTimeout); // Отменяем таймер текущего трека
    playTrack(); // Запускаем следующий трек
}

// Отправка информации о треке
function broadcastTrackInfo() {
    const trackName = currentTrack.replace('.mp3', '');
    const elapsedTime = (Date.now() - startTime) / 1000;
    const serverTime = Date.now();
    const nextTracks = trackQueue.slice(currentTrackIndex, currentTrackIndex + 5);

    // Получаем длительности
    const durations = nextTracks.map(filename => {
        const fullPath = path.join(MUSIC_DIR, filename);
        try {
            const metadata = ffmpeg.ffprobeSync(fullPath);
            return metadata.format.duration;
        } catch {
            return 180; // если не удалось — 3 минуты
        }
    });

    io.emit('track-info', {
        track: trackName,
        likes,
        elapsed: elapsedTime,
        serverTime,
        queue: nextTracks.map(t => t.replace('.mp3', '')),
        durations,
    });
}

// Потоковое воспроизведение
app.get('/stream', (req, res) => {
    if (!currentTrack) return res.status(404).send('No track playing');

    const trackPath = path.join(MUSIC_DIR, currentTrack);
    const elapsed = (Date.now() - startTime) / 1000;

    const ffmpegStream = ffmpeg(trackPath)
        .setStartTime(elapsed)
        .format('mp3')
        .audioCodec('libmp3lame')
        .on('error', (err) => {
            console.error('FFmpeg error:', err.message);
            if (!res.headersSent) {
                res.status(500).send('Stream error');
            }
        });

    req.on('close', () => {
        ffmpegStream.kill('SIGKILL');
    });

    res.on('close', () => {
        ffmpegStream.kill('SIGKILL');
    });

    ffmpegStream.pipe(res, { end: true });
});

// События сокетов
io.on('connection', (socket) => {
    console.log('New client connected');
    onlineClients++;
    io.emit('online', onlineClients);

    socket.emit('track-info', {
        track: currentTrack ? currentTrack.replace('.mp3', '') : '',
        likes,
        elapsed: (Date.now() - startTime) / 1000,
        serverTime: Date.now(),
        queue: trackQueue.slice(currentTrackIndex, currentTrackIndex + 10).map(t => t.replace('.mp3', '')),
    });


    socket.on('like', () => {
        likes++;
        broadcastTrackInfo();
    });

    socket.on('report', () => {
        // Убедимся, что файл существует, или создаем новый
        if (!fs.existsSync(REPORTS_FILE)) {
            fs.writeJsonSync(REPORTS_FILE, []);
        }

        const reports = fs.readJsonSync(REPORTS_FILE, { throws: false }) || [];
        reports.push({ track: currentTrack, timestamp: new Date().toISOString() });
        fs.writeJsonSync(REPORTS_FILE, reports, { spaces: 2 });
        console.log(`Report added for track: ${currentTrack}`);
    });

    socket.on('disconnect', () => {
        onlineClients--;
        io.emit('online', onlineClients);
        console.log('Client disconnected');
    });
});

// Чтение команд из консоли
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
    const command = input.trim();

    if (command === 'skip') {
        skipTrack(); // Пропуск трека
    } else if (command === 'queue') {
        console.log('Current queue:', trackQueue.slice(currentTrackIndex));
    } else {
        console.log(`Unknown command: ${command}`);
    }
});

// Запуск сервера
const PORT = process.env.PORT;
server.listen(PORT, () => {
    console.log(`Server running at https://test2-i61r.onrender.com:${PORT}`);
    initializeTrackQueue(); // Инициализируем очередь треков
    playTrack(); // Запускаем первый трек
});
