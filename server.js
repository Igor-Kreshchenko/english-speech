const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const express = require("express");
const ffmpeg = require("fluent-ffmpeg");

const app = express();
const port = Number(process.env.PORT) || 3000;
const jobs = new Map();
const tempRoot = path.join(os.tmpdir(), "english-speech-generator");
const jobTtlMs = 60 * 60 * 1000;
const maxActiveJobs = 2;
const maxPairs = 100;
const maxTextLength = 20_000;
const previewTexts = {
  ru: "Здравствуйте! Это пример звучания выбранного русского голоса.",
  en: "Hello! This is a preview of the selected English voice.",
};
let voicesCache;
const ffmpegCommand = process.env.FFMPEG_PATH;

if (ffmpegCommand) {
  ffmpeg.setFfmpegPath(ffmpegCommand);
}

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/voices", async (_req, res) => {
  try {
    const voices = await loadVoiceList();
    res.json({
      ru: voices.filter((voice) => voice.language === "ru"),
      en: voices.filter((voice) => voice.language === "en"),
    });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.post("/api/voices/preview", async (req, res) => {
  const { language, voice } = req.body || {};
  if (!["ru", "en"].includes(language) || typeof voice !== "string") {
    return res.status(400).json({ error: "Укажите русский или английский голос для образца." });
  }

  try {
    const voices = await loadVoiceList();
    if (!voices.some((item) => item.language === language && item.name === voice)) {
      return res.status(400).json({ error: "Выбранный голос недоступен для этого языка." });
    }

    const directory = path.join(tempRoot, "previews", randomUUID());
    const audioPath = path.join(directory, "preview.mp3");
    await fsp.mkdir(directory, { recursive: true });
    try {
      await runEdgeTts(previewTexts[language], voice, audioPath);
    } catch (error) {
      await fsp.rm(directory, { recursive: true, force: true });
      throw error;
    }
    res.type("audio/mpeg").sendFile(audioPath, (error) => {
      fsp.rm(directory, { recursive: true, force: true }).catch((cleanupError) => {
        console.error("Не удалось удалить файл образца голоса:", cleanupError);
      });
      if (error && !res.headersSent) {
        res.status(500).json({ error: "Не удалось передать образец голоса." });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function parsePairs(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Введите список фраз.");
  }
  if (text.length > maxTextLength) {
    throw new Error(`Текст не должен превышать ${maxTextLength} символов.`);
  }

  const pairs = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const separatorIndex = line.indexOf("->");
    if (separatorIndex < 0) {
      throw new Error(`В строке ${index + 1} нет разделителя "->".`);
    }

    const ru = line.slice(0, separatorIndex).trim();
    const en = line.slice(separatorIndex + 2).trim();
    if (!ru || !en) {
      throw new Error(`В строке ${index + 1} должны быть обе фразы.`);
    }

    pairs.push({ ru, en });
    if (pairs.length > maxPairs) {
      throw new Error(`Можно сгенерировать не более ${maxPairs} пар за раз.`);
    }
  }

  if (!pairs.length) throw new Error("Не найдено ни одной пары фраз.");
  return pairs;
}

function validatePause(value, name) {
  const pause = Number(value);
  if (!Number.isFinite(pause) || pause < 0 || pause > 30) {
    throw new Error(`Пауза «${name}» должна быть от 0 до 30 секунд.`);
  }
  return pause;
}

function getEdgeTtsCandidates() {
  const commandOverride = process.env.EDGE_TTS_COMMAND;
  return commandOverride
    ? [commandOverride]
    : [path.join(os.homedir(), ".local", "bin", "edge-tts"), "edge-tts"];
}

function loadVoiceList() {
  if (voicesCache) return voicesCache;

  voicesCache = new Promise((resolve, reject) => {
    const candidates = getEdgeTtsCandidates();
    let candidateIndex = 0;
    let stderr = "";

    const start = () => {
      const child = spawn(candidates[candidateIndex++], ["--list-voices"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Получение списка голосов edge-tts превысило лимит времени."));
      }, 30_000);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout = (stdout + chunk).slice(-2_000_000);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error.code === "ENOENT" && candidateIndex < candidates.length) {
          start();
        } else if (error.code === "ENOENT") {
          voicesCache = undefined;
          reject(new Error("Не найден edge-tts. Проверьте EDGE_TTS_COMMAND и установку edge-tts."));
        } else {
          voicesCache = undefined;
          reject(error);
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          voicesCache = undefined;
          reject(new Error(`Не удалось получить список голосов edge-tts${stderr ? `: ${stderr.trim()}` : "."}`));
          return;
        }

        const voices = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .map((line) => line.split(/\s{2,}/))
          .filter((columns) => columns.length >= 4 && /^(en|ru)-/i.test(columns[0]))
          .map(([name, gender, categories, personalities]) => ({
            name,
            language: name.toLowerCase().startsWith("ru-") ? "ru" : "en",
            gender: gender.toLowerCase(),
            categories,
            personalities,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (!voices.length) {
          voicesCache = undefined;
          reject(new Error("edge-tts не вернул русские или английские голоса."));
          return;
        }
        resolve(voices);
      });
    };

    start();
  });

  return voicesCache;
}

function runEdgeTts(text, voice, outputPath) {
  return new Promise((resolve, reject) => {
    const candidates = getEdgeTtsCandidates();
    let stderr = "";
    let candidateIndex = 0;

    const start = () => {
      const command = candidates[candidateIndex++];
      const child = spawn(
        command,
        ["--voice", voice, "--text", text, "--write-media", outputPath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let handled = false;
      const timeout = setTimeout(() => {
        handled = true;
        child.kill("SIGKILL");
        reject(new Error("Edge TTS не завершился за отведенное время."));
      }, 120_000);

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on("error", (error) => {
        if (handled) return;
        handled = true;
        clearTimeout(timeout);
        if (error.code === "ENOENT" && candidateIndex < candidates.length) {
          start();
        } else if (error.code === "ENOENT") {
          reject(
            new Error(
              "Не найден edge-tts. Убедитесь, что приложение запущено от того же пользователя, который установил пакет. Проверьте ~/.local/bin/edge-tts или задайте EDGE_TTS_COMMAND.",
            ),
          );
        } else {
          reject(error);
        }
      });
      child.on("close", (code) => {
        if (handled) return;
        handled = true;
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`Ошибка edge-tts${stderr ? `: ${stderr.trim()}` : "."}`));
      });
    };

    start();
  });
}

function transcodeToMp3(source, destination) {
  return new Promise((resolve, reject) => {
    ffmpeg(source)
      .audioCodec("libmp3lame")
      .audioFrequency(44_100)
      .audioChannels(2)
      .audioBitrate("128k")
      .format("mp3")
      .on("error", reject)
      .on("end", resolve)
      .save(destination);
  });
}

function createSilence(seconds, destination) {
  const sampleRate = 44_100;
  const channels = 2;
  const bytesPerSample = 2;
  const samples = Math.round(sampleRate * seconds);
  const dataSize = samples * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);
  const header = wav.subarray(0, 44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  const wavPath = `${destination}.wav`;
  return fsp.writeFile(wavPath, wav).then(async () => {
    try {
      await transcodeToMp3(wavPath, destination);
    } finally {
      await fsp.unlink(wavPath);
    }
  });
}

function concatenateMp3(segments, destination, listPath) {
  const list = segments
    .map((segment) => `file '${path.resolve(segment).replaceAll("\\", "/").replaceAll("'", "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listPath, `${list}\n`, "utf8");

  return new Promise((resolve, reject) => {
    ffmpeg(listPath)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c:a libmp3lame", "-b:a 128k"])
      .format("mp3")
      .on("error", reject)
      .on("end", resolve)
      .save(destination);
  });
}

function updateJob(job, progress, status) {
  job.progress = progress;
  job.status = status;
  job.updatedAt = Date.now();
}

async function generateJob(job) {
  const segments = [];
  const silenceFiles = new Map();
  const segmentCount = job.pairs.length * 2;
  let completedSegments = 0;
  const appendSilence = async (kind, duration) => {
    if (!duration) return;
    const key = `${kind}-${duration}`;
    if (!silenceFiles.has(key)) {
      const silencePath = path.join(job.directory, `silence-${key}.mp3`);
      await createSilence(duration, silencePath);
      silenceFiles.set(key, silencePath);
    }
    segments.push(silenceFiles.get(key));
  };

  try {
    await fsp.mkdir(job.directory, { recursive: true });
    for (const [index, pair] of job.pairs.entries()) {
      for (const [language, text, voice] of [
        ["ru", pair.ru, job.ruVoice],
        ["en", pair.en, job.enVoice],
      ]) {
        const rawPath = path.join(job.directory, `${index}-${language}-raw.mp3`);
        const normalizedPath = path.join(job.directory, `${index}-${language}.mp3`);
        await runEdgeTts(text, voice, rawPath);
        await transcodeToMp3(rawPath, normalizedPath);
        await fsp.unlink(rawPath);
        segments.push(normalizedPath);
        completedSegments += 1;
        updateJob(
          job,
          Math.round((completedSegments / segmentCount) * 90),
          `Озвучивание: ${completedSegments} из ${segmentCount}`,
        );
        if (language === "ru") {
          await appendSilence("translation", job.translationPause);
        }
      }

      await appendSilence("pair", job.pairPause);
    }

    updateJob(job, 95, "Склеивание аудио");
    const outputPath = path.join(job.directory, "result.mp3");
    await concatenateMp3(
      segments,
      outputPath,
      path.join(job.directory, "concat.txt"),
    );
    job.outputPath = outputPath;
    updateJob(job, 100, "Готово");
  } catch (error) {
    job.error = error.message;
    updateJob(job, job.progress, "Ошибка");
  }
}

function getJob(req, res, next) {
  const job = jobs.get(req.params.id);
  if (!job || Date.now() - job.updatedAt > jobTtlMs) {
    if (job) {
      jobs.delete(job.id);
      fsp.rm(job.directory, { recursive: true, force: true }).catch((error) => {
        console.error("Не удалось удалить временную папку:", error);
      });
    }
    return res.status(404).json({ error: "Задача не найдена или срок ее хранения истек." });
  }
  req.job = job;
  next();
}

app.post("/api/generate", async (req, res) => {
  try {
    const pairs = parsePairs(req.body?.text);
    const ruVoice = req.body?.ruVoice;
    const enVoice = req.body?.enVoice;
    const voices = await loadVoiceList();
    if (!voices.some((voice) => voice.language === "ru" && voice.name === ruVoice)) {
      throw new Error("Выбран недопустимый русский голос.");
    }
    if (!voices.some((voice) => voice.language === "en" && voice.name === enVoice)) {
      throw new Error("Выбран недопустимый английский голос.");
    }

    const activeJobs = [...jobs.values()].filter(
      (job) => job.status !== "Готово" && job.status !== "Ошибка",
    ).length;
    if (activeJobs >= maxActiveJobs) {
      return res.status(429).json({ error: "Сервер уже обрабатывает две задачи. Попробуйте позже." });
    }

    const job = {
      id: randomUUID(),
      directory: path.join(tempRoot, randomUUID()),
      pairs,
      ruVoice,
      enVoice,
      translationPause: validatePause(req.body?.translationPause, "между русской и английской фразой"),
      pairPause: validatePause(req.body?.pairPause, "между парами"),
      progress: 0,
      status: "В очереди",
      updatedAt: Date.now(),
    };
    jobs.set(job.id, job);
    res.status(202).json({ jobId: job.id });
    generateJob(job);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/jobs/:id", getJob, (req, res) => {
  const { job } = req;
  res.json({
    progress: job.progress,
    status: job.status,
    ...(job.error && { error: job.error }),
    ...(job.outputPath && { audioUrl: `/api/jobs/${job.id}/audio` }),
  });
});

app.get("/api/jobs/:id/audio", getJob, (req, res) => {
  if (!req.job.outputPath) return res.status(409).json({ error: "Аудио еще не готово." });
  res.type("audio/mpeg").sendFile(req.job.outputPath);
});

app.get("/api/jobs/:id/download", getJob, (req, res) => {
  if (!req.job.outputPath) return res.status(409).json({ error: "Аудио еще не готово." });
  res.download(req.job.outputPath, "english-speech.mp3");
});

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt <= jobTtlMs) continue;
    jobs.delete(id);
    fsp.rm(job.directory, { recursive: true, force: true }).catch((error) => {
      console.error("Не удалось удалить временную папку:", error);
    });
  }
}, 10 * 60 * 1000).unref();

app.listen(port, () => {
  console.log(`English Speech запущен: http://localhost:${port}`);
});
