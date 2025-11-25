import { createClient } from "@deepgram/sdk";
import { getPreferenceValues, showToast, Toast } from "@raycast/api";
import { exec } from "child_process";
import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { validateAudioFile, getDetailedAudioMetadata, AudioMetadata } from "./audioUtils";
import { getFfmpegPath } from "./binaryUtils";

const execPromise = promisify(exec);

const TARGET_CHUNK_DURATION_SECONDS = 300; // 5 minutes
const MIN_CHUNK_DURATION_SECONDS = 60; // 1 minute minimum
const MAX_CHUNK_SIZE_BYTES = 150 * 1024 * 1024; // 150MB hard limit
const MAX_CONCURRENT_TRANSCRIPTIONS = 3;

interface Preferences {
  deepgramApiKey: string;
  deepgramModel: string;
  smartFormat: boolean;
  detectLanguage: boolean;
  autoOpenTranscription?: boolean;
  defaultCopyFormat?: string;
  enableAudioValidation?: boolean;
  historyLimit?: number;
  showNotifications?: boolean;
}

interface TranscriptionResult {
  transcription: string;
  rawData: string;
  chunkedFileInfo: {
    size: number;
    extension: string;
  };
  audioMetadata?: AudioMetadata;
  originalFileInfo?: {
    size: number;
    format: string;
    isValidAudio: boolean;
  };
}

interface ProgressCallback {
  (stage: string, progress: number, total: number, message: string): void;
}

class AbortError extends Error {
  constructor(message = "The operation was aborted.") {
    super(message);
    this.name = "AbortError";
  }
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortError();
  }
}

async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execPromise(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
    );
    const duration = parseFloat(stdout.trim());
    if (!isNaN(duration) && isFinite(duration)) {
      return duration;
    }
  } catch (e) {
    console.warn("Failed to get audio duration:", e);
  }
  return 0;
}

async function chunkAudioFile(
  ffmpegPath: string,
  filePath: string,
  tempDir: string,
  signal: AbortSignal,
): Promise<{ chunks: string[]; format: string }> {
  checkAborted(signal);

  const fileStats = await fs.promises.stat(filePath);
  const fileSize = fileStats.size;
  const duration = await getAudioDuration(filePath);

  // Calculate optimal chunk duration based on file characteristics
  let chunkDuration = TARGET_CHUNK_DURATION_SECONDS;

  if (duration > 0 && fileSize > 0) {
    const bytesPerSecond = fileSize / duration;
    const estimatedChunkSize = bytesPerSecond * TARGET_CHUNK_DURATION_SECONDS;

    // If estimated chunk would be too large, reduce duration
    if (estimatedChunkSize > MAX_CHUNK_SIZE_BYTES) {
      chunkDuration = Math.max(MIN_CHUNK_DURATION_SECONDS, Math.floor(MAX_CHUNK_SIZE_BYTES / bytesPerSecond));
    }
  }

  // For small files, process as single chunk
  if (fileSize < MAX_CHUNK_SIZE_BYTES && duration <= TARGET_CHUNK_DURATION_SECONDS) {
    const singleChunkPath = path.join(tempDir, "chunk_000.wav");
    const copyCommand = `"${ffmpegPath}" -i "${filePath}" -c:a pcm_s16le -ar 16000 -ac 1 -y "${singleChunkPath}"`;

    try {
      await execPromise(copyCommand, { signal });
      const stats = await fs.promises.stat(singleChunkPath);
      if (stats.size > 0) {
        return { chunks: ["chunk_000.wav"], format: "wav" };
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      console.warn("Single chunk conversion failed, will try segmenting:", e);
    }
  }

  checkAborted(signal);

  // Try WAV format first (better quality for transcription)
  const wavPattern = path.join(tempDir, "chunk_%03d.wav");
  const wavCommand = `"${ffmpegPath}" -i "${filePath}" -f segment -segment_time ${chunkDuration} -c:a pcm_s16le -ar 16000 -ac 1 -reset_timestamps 1 -y "${wavPattern}"`;

  try {
    await execPromise(wavCommand, { signal });
    checkAborted(signal);

    const files = await fs.promises.readdir(tempDir);
    const wavChunks = files.filter((f) => f.endsWith(".wav")).sort();

    if (wavChunks.length > 0) {
      // Verify all chunks are within size limit
      let allValid = true;
      for (const chunk of wavChunks) {
        const stats = await fs.promises.stat(path.join(tempDir, chunk));
        if (stats.size > MAX_CHUNK_SIZE_BYTES) {
          allValid = false;
          break;
        }
      }

      if (allValid) {
        console.log(`Successfully created ${wavChunks.length} WAV chunks`);
        return { chunks: wavChunks, format: "wav" };
      }

      // Clean up oversized chunks
      await Promise.all(wavChunks.map((f) => fs.promises.unlink(path.join(tempDir, f)).catch(() => {})));
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    console.warn("WAV chunking failed, trying MP3:", e);
  }

  checkAborted(signal);

  // Fall back to MP3 with reduced duration
  const reducedDuration = Math.max(MIN_CHUNK_DURATION_SECONDS, Math.floor(chunkDuration * 0.5));
  const mp3Pattern = path.join(tempDir, "chunk_%03d.mp3");
  const mp3Command = `"${ffmpegPath}" -i "${filePath}" -f segment -segment_time ${reducedDuration} -c:a libmp3lame -b:a 128k -ar 16000 -ac 1 -reset_timestamps 1 -y "${mp3Pattern}"`;

  try {
    await execPromise(mp3Command, { signal });
    checkAborted(signal);

    const files = await fs.promises.readdir(tempDir);
    const mp3Chunks = files.filter((f) => f.endsWith(".mp3")).sort();

    if (mp3Chunks.length > 0) {
      console.log(`Successfully created ${mp3Chunks.length} MP3 chunks`);
      return { chunks: mp3Chunks, format: "mp3" };
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    console.error("MP3 chunking also failed:", e);
  }

  throw new Error(
    "Failed to chunk audio file. Please ensure the file is a valid audio format and FFmpeg is properly installed.",
  );
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number, signal: AbortSignal): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const executing = new Set<Promise<void>>();

  for (const [index, task] of tasks.entries()) {
    checkAborted(signal);

    const p = (async () => {
      results[index] = await task();
    })();

    executing.add(p);
    const cleanup = () => executing.delete(p);
    p.then(cleanup, cleanup);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

export async function transcribeAudio(
  filePath: string,
  signal: AbortSignal,
  progressCallback?: ProgressCallback,
): Promise<TranscriptionResult> {
  checkAborted(signal);

  const preferences = getPreferenceValues<Preferences>();
  const showNotifications = preferences.showNotifications !== false;

  let audioValidation: { isValid: boolean; format?: { ext: string; mime: string }; error?: string } = {
    isValid: true,
  };

  // Stage 1: Validate audio file
  if (preferences.enableAudioValidation !== false) {
    progressCallback?.("validation", 1, 4, "Validating audio file...");
    audioValidation = await validateAudioFile(filePath);
    if (!audioValidation.isValid) {
      throw new Error(`Audio validation failed: ${audioValidation.error}`);
    }
  }

  checkAborted(signal);

  // Stage 2: Prepare processing
  progressCallback?.("preparation", 2, 4, "Preparing audio...");

  const ffmpegPath = await getFfmpegPath();
  const deepgram = createClient(preferences.deepgramApiKey);
  const tempDir = await fs.promises.mkdtemp(path.join(tmpdir(), "voxscribe-"));

  let toast: Toast | undefined;
  if (showNotifications) {
    toast = await showToast({
      style: Toast.Style.Animated,
      title: "Processing audio...",
    });
  }

  try {
    const fileStats = await fs.promises.stat(filePath);
    const fileSize = fileStats.size;

    checkAborted(signal);

    // Stage 3: Chunk audio
    progressCallback?.("chunking", 3, 4, "Chunking audio file...");

    const { chunks: chunkFiles, format: chunkFormat } = await chunkAudioFile(ffmpegPath, filePath, tempDir, signal);

    if (chunkFiles.length === 0) {
      throw new Error("No audio chunks were generated.");
    }

    console.log(`Created ${chunkFiles.length} ${chunkFormat} chunks`);

    checkAborted(signal);

    // Stage 4: Transcribe chunks
    progressCallback?.("transcription", 4, 4, `Transcribing ${chunkFiles.length} chunk(s)...`);

    if (toast) {
      toast.message = `Transcribing ${chunkFiles.length} chunk(s)...`;
    }

    let processedCount = 0;
    let totalSize = 0;
    const rawResults: unknown[] = [];

    const transcriptionTasks = chunkFiles.map((chunkFileName, index) => {
      return async () => {
        checkAborted(signal);

        const chunkFilePath = path.join(tempDir, chunkFileName);
        const audioBuffer = await fs.promises.readFile(chunkFilePath);
        totalSize += audioBuffer.length;

        try {
          const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
            model: preferences.deepgramModel,
            detect_language: preferences.detectLanguage,
            smart_format: preferences.smartFormat,
          });

          processedCount++;

          if (toast) {
            toast.message = `Transcribed ${processedCount}/${chunkFiles.length}`;
          }

          if (error) {
            console.error(`Chunk ${index + 1} error:`, error);
            return { index, transcription: "", rawData: null };
          }

          const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
          return { index, transcription: transcript, rawData: result };
        } catch (e) {
          console.error(`Failed to transcribe chunk ${index + 1}:`, e);
          return { index, transcription: "", rawData: null };
        }
      };
    });

    const results = await runWithConcurrency(transcriptionTasks, MAX_CONCURRENT_TRANSCRIPTIONS, signal);

    // Sort by index and combine results
    results.sort((a, b) => a.index - b.index);

    const combinedTranscription = results
      .map((r) => r.transcription)
      .filter((t) => t.length > 0)
      .join(" ")
      .trim();

    for (const result of results) {
      if (result.rawData) {
        rawResults.push(result.rawData);
      }
    }

    // Get audio metadata
    const audioMetadata = await getDetailedAudioMetadata(filePath);

    if (toast) {
      toast.style = Toast.Style.Success;
      toast.title = "Transcription complete";
      toast.message = undefined;
    }

    return {
      transcription: combinedTranscription,
      rawData: JSON.stringify(rawResults),
      chunkedFileInfo: {
        size: totalSize,
        extension: chunkFormat,
      },
      audioMetadata: audioMetadata || undefined,
      originalFileInfo: {
        size: fileSize,
        format: audioValidation.format?.ext || "unknown",
        isValidAudio: audioValidation.isValid,
      },
    };
  } finally {
    // Clean up temp directory
    await fs.promises
      .rm(tempDir, { recursive: true, force: true })
      .catch((e) => console.error("Failed to clean up temp directory:", e));
  }
}
