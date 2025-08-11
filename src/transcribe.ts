import { createClient } from "@deepgram/sdk";
import { getPreferenceValues, showToast, Toast } from "@raycast/api";
import axios from "axios";
import { exec } from "child_process";
import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";

const execPromise = promisify(exec);

async function getFfmpegPath(): Promise<string> {
  try {
    // Check if ffmpeg is in the PATH and executable
    await execPromise("ffmpeg -version");
    return "ffmpeg";
  } catch (error) {
    // If not in PATH, check common Homebrew paths
    const commonPaths = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
    for (const path of commonPaths) {
      try {
        await execPromise(`${path} -version`);
        return path;
      } catch (e) {
        // Continue to the next path
      }
    }
  }
  // If ffmpeg is not found anywhere, throw an error
  throw new Error("FFmpeg not found. Please install FFmpeg and ensure it is in your system's PATH.");
}

const CHUNK_DURATION_SECONDS = 300;
const CHUNK_FORMAT = "wav";
const LARGE_FILE_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_TARGET_CHUNK_SIZE_MB = 25;
const MAX_CONCURRENT_TRANSCRIPTIONS = 3;

async function runFfmpeg(command: string, signal: AbortSignal, retries = 1): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await execPromise(command, { signal });
      return;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (attempt < retries) {
        console.warn(`FFmpeg command failed (attempt ${attempt + 1}/${retries + 1}). Retrying...`, error);
      } else {
        throw new Error(
          `FFmpeg command failed after ${retries + 1} attempts: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

interface Preferences {
  deepgramApiKey: string;
  deepgramModel: string;
  smartFormat: boolean;
  detectLanguage: boolean;
  maxChunkSizeMB?: number;
}

interface TranscriptionResult {
  transcription: string;
  rawData: string;
  chunkedFileInfo: {
    size: number;
    extension: string;
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

export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await axios.get("https://api.deepgram.com/v1/auth/token", {
      headers: {
        Authorization: `Token ${apiKey}`,
      },
    });

    return response.status === 200;
  } catch (error) {
    console.error("Error validating API key:", error);
    return false;
  }
}

export async function transcribeAudio(
  filePath: string,
  signal: AbortSignal,
  progressCallback?: ProgressCallback,
): Promise<TranscriptionResult> {
  if (signal.aborted) throw new AbortError();
  const preferences = getPreferenceValues<Preferences>();
  const targetChunkSizeBytes = (preferences.maxChunkSizeMB ?? DEFAULT_TARGET_CHUNK_SIZE_MB) * 1024 * 1024;

  progressCallback?.("validation", 0, 4, "Validating API key...");
  const isValidApiKey = await validateApiKey(preferences.deepgramApiKey);

  if (!isValidApiKey) {
    throw new Error("Invalid API key");
  }

  progressCallback?.("preparation", 1, 4, "Preparing audio processing...");
  const ffmpegPath = await getFfmpegPath();
  const deepgram = createClient(preferences.deepgramApiKey);
  const tempDir = await fs.promises.mkdtemp(path.join(tmpdir(), "voxscribe-chunks-"));

  try {
    const outputPattern = path.join(tempDir, `chunk_%03d.${CHUNK_FORMAT}`);
    let overallSize = 0;

    console.log(`Creating temporary directory for chunks: ${tempDir}`);
    progressCallback?.("chunking", 2, 4, "Chunking audio file...");
    showToast({ style: Toast.Style.Animated, title: "Preparing audio..." });

    const fileStats = await fs.promises.stat(filePath);
    const fileSize = fileStats.size;
    const estimatedChunks = Math.max(1, Math.ceil(fileSize / targetChunkSizeBytes));
    progressCallback?.(
      "preparation",
      1,
      4,
      `Preparing audio (~${estimatedChunks} chunk${estimatedChunks > 1 ? "s" : ""})...`,
    );

    let chunkDuration = CHUNK_DURATION_SECONDS;

    if (fileSize > LARGE_FILE_THRESHOLD_BYTES) {
      try {
        const { stdout } = await execPromise(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        );
        const duration = parseFloat(stdout.trim());
        if (!isNaN(duration) && isFinite(duration)) {
          const bitrate = (fileSize * 8) / duration; // bits per second
          const sizeBasedDuration = Math.floor((targetChunkSizeBytes * 8) / bitrate);
          if (sizeBasedDuration > 0) {
            chunkDuration = Math.min(CHUNK_DURATION_SECONDS, sizeBasedDuration);
          }
        }
      } catch (e) {
        console.warn("Failed to determine audio duration, using default chunk duration.", e);
      }
    }

    const segmentCommand = `"${ffmpegPath}" -i "${filePath}" -f segment -segment_time ${chunkDuration} -c:a pcm_s16le -reset_timestamps 1 -map 0:a -y "${outputPattern}"`;
    console.log(`Executing FFmpeg segment command: ${segmentCommand}`);

    await runFfmpeg(segmentCommand, signal, 1);
    console.log("Audio chunking and re-encoding complete.");
    if (signal.aborted) throw new AbortError();

    const chunkFiles = (await fs.promises.readdir(tempDir)).filter((f) => f.endsWith(`.${CHUNK_FORMAT}`)).sort();
    console.log(`Found ${chunkFiles.length} chunks to transcribe.`);

    if (chunkFiles.length === 0) {
      throw new Error("No audio chunks were generated. Check the input file and FFmpeg setup.");
    }

    let combinedTranscription = "";
    const rawResults = [];
    const transcriptionTasks: (() => Promise<{ index: number; transcription: string; rawData: unknown }>)[] = [];
    let processedCount = 0;

    progressCallback?.(
      "transcription",
      3,
      4,
      `Transcribing ${chunkFiles.length} audio chunk${chunkFiles.length > 1 ? "s" : ""}...`,
    );
    showToast({
      style: Toast.Style.Animated,
      title: "Transcribing audio",
      message: `Processing ${chunkFiles.length} chunk(s)...`,
    });

    const createTranscriptionTask = (chunkFileName: string, chunkFilePath: string, index: number) => {
      return async () => {
        console.log(`Transcribing chunk ${index + 1}/${chunkFiles.length}: ${chunkFileName}`);
        try {
          const audioBuffer = await fs.promises.readFile(chunkFilePath);
          overallSize += audioBuffer.length;
          const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
            model: preferences.deepgramModel,
            detect_language: preferences.detectLanguage,
            smart_format: preferences.smartFormat,
          });

          processedCount++;
          progressCallback?.("transcription", 3, 4, `Transcribed ${processedCount} of ${chunkFiles.length} chunks`);
          await showToast({
            style: Toast.Style.Animated,
            title: "Transcribing audio",
            message: `Processed ${processedCount} of ${chunkFiles.length} chunks`,
          });

          if (error) {
            console.error(`Error transcribing chunk ${chunkFileName}:`, error);
            return { index, transcription: `[Transcription Error for chunk ${index + 1}]`, rawData: null };
          }
          if (result?.results?.channels?.[0]?.alternatives?.[0]?.transcript) {
            const transcription = result.results.channels[0].alternatives[0].transcript;
            return {
              index,
              transcription: transcription,
              rawData: result,
            };
          } else {
            console.warn(`No transcript returned for chunk ${chunkFileName}`);
            return { index, transcription: `[No transcription for chunk ${index + 1}]`, rawData: null };
          }
        } catch (chunkError) {
          console.error(`Failed to process or transcribe chunk ${chunkFileName}:`, chunkError);
          return { index, transcription: `[Processing Error for chunk ${index + 1}]`, rawData: null };
        }
      };
    };

    transcriptionTasks.push(
      ...chunkFiles.map((chunkFileName, index) => {
        if (signal.aborted) throw new AbortError();
        const chunkFilePath = path.join(tempDir, chunkFileName);
        return () => createTranscriptionTask(chunkFileName, chunkFilePath, index);
      }),
    );

    const abortPromise = new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        reject(new AbortError());
      });
    });

    const results = (await Promise.race([
      runWithConcurrency(transcriptionTasks, MAX_CONCURRENT_TRANSCRIPTIONS),
      abortPromise,
    ])) as {
      index: number;
      transcription: string;
      rawData: unknown;
    }[];

    results.sort((a, b) => a.index - b.index);

    for (const result of results) {
      combinedTranscription += result.transcription + " ";
      if (result.rawData) {
        rawResults.push(result.rawData);
      }
    }

    progressCallback?.("completion", 4, 4, "Transcription completed successfully!");
    await showToast({ style: Toast.Style.Success, title: "Transcription complete!" });

    return {
      transcription: combinedTranscription.trim(),
      rawData: JSON.stringify(rawResults),
      chunkedFileInfo: {
        size: overallSize,
        extension: CHUNK_FORMAT,
      },
    };
  } finally {
    console.log(`Attempting to remove temporary directory: ${tempDir}`);
    await fs.promises
      .rm(tempDir, { recursive: true, force: true })
      .catch((e) => console.error(`Failed to delete temp directory ${tempDir}:`, e));
    console.log("Temporary directory removed.");
  }
}
