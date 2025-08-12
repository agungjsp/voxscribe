import { createClient } from "@deepgram/sdk";
import { getPreferenceValues, showToast, Toast } from "@raycast/api";
import axios from "axios";
import { exec } from "child_process";
import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { validateAudioFile, getDetailedAudioMetadata, AudioMetadata } from "./audioUtils";

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
const CHUNK_FORMAT = "wav"; // Default format, but can fall back to mp3
const LARGE_FILE_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_TARGET_CHUNK_SIZE_MB = 150; // Increased to handle larger chunks better
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

async function segmentAudioWithRetry(
  ffmpegPath: string,
  filePath: string,
  tempDir: string,
  initialDuration: number,
  targetChunkSizeBytes: number,
  signal: AbortSignal,
): Promise<string[]> {
  let chunkDuration = initialDuration;
  const outputPattern = path.join(tempDir, `chunk_%03d.${CHUNK_FORMAT}`);

  // Strategy 1: Try with original format first (more efficient)
  console.log("🎵 Attempting to chunk audio with original format...");
  for (let attempt = 0; attempt < 3; attempt++) {
    const segmentCommand = `"${ffmpegPath}" -i "${filePath}" -f segment -segment_time ${chunkDuration} -c copy -reset_timestamps 1 -map 0:a -y "${outputPattern}"`;
    console.log(`Executing FFmpeg segment command (copy codec): ${segmentCommand}`);

    try {
      await runFfmpeg(segmentCommand, signal, 1);
      const chunkFiles = (await fs.promises.readdir(tempDir)).filter((f) => f.endsWith(`.${CHUNK_FORMAT}`)).sort();

      if (chunkFiles.length > 0) {
        const oversized = [];
        for (const f of chunkFiles) {
          const stats = await fs.promises.stat(path.join(tempDir, f));
          if (stats.size > targetChunkSizeBytes) {
            oversized.push(f);
          }
        }

        if (oversized.length === 0) {
          console.log(`✅ Successfully chunked with copy codec: ${chunkFiles.length} chunks`);
          return chunkFiles;
        }

        console.warn(`⚠️ Copy codec chunks exceed size limit. Attempt ${attempt + 1}/3`);
        await Promise.all(chunkFiles.map((f) => fs.promises.unlink(path.join(tempDir, f))));
        chunkDuration = Math.max(30, Math.floor(chunkDuration * 0.7)); // More conservative reduction
      }
    } catch (error) {
      console.warn(`Copy codec failed on attempt ${attempt + 1}:`, error);
      await Promise.all(
        (await fs.promises.readdir(tempDir))
          .filter((f) => f.endsWith(`.${CHUNK_FORMAT}`))
          .map((f) => fs.promises.unlink(path.join(tempDir, f)).catch(() => {})),
      );
      chunkDuration = Math.max(30, Math.floor(chunkDuration * 0.7));
    }
  }

  // Strategy 2: Use compressed format (mp3) for smaller chunks
  console.log("🎵 Falling back to compressed format...");
  chunkDuration = Math.max(60, initialDuration); // Reset to reasonable duration
  const mp3Pattern = path.join(tempDir, `chunk_%03d.mp3`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const segmentCommand = `"${ffmpegPath}" -i "${filePath}" -f segment -segment_time ${chunkDuration} -c:a mp3 -b:a 128k -reset_timestamps 1 -map 0:a -y "${mp3Pattern}"`;
    console.log(`Executing FFmpeg segment command (mp3): ${segmentCommand}`);

    try {
      await runFfmpeg(segmentCommand, signal, 1);
      const chunkFiles = (await fs.promises.readdir(tempDir)).filter((f) => f.endsWith(".mp3")).sort();

      if (chunkFiles.length > 0) {
        const oversized = [];
        for (const f of chunkFiles) {
          const stats = await fs.promises.stat(path.join(tempDir, f));
          if (stats.size > targetChunkSizeBytes) {
            oversized.push(f);
          }
        }

        if (oversized.length === 0) {
          console.log(`✅ Successfully chunked with mp3 codec: ${chunkFiles.length} chunks`);
          return chunkFiles;
        }

        console.warn(`⚠️ Mp3 chunks still exceed size limit. Attempt ${attempt + 1}/3`);
        await Promise.all(chunkFiles.map((f) => fs.promises.unlink(path.join(tempDir, f))));
        chunkDuration = Math.max(30, Math.floor(chunkDuration * 0.8));
      }
    } catch (error) {
      console.warn(`Mp3 codec failed on attempt ${attempt + 1}:`, error);
      await Promise.all(
        (await fs.promises.readdir(tempDir))
          .filter((f) => f.endsWith(".mp3"))
          .map((f) => fs.promises.unlink(path.join(tempDir, f)).catch(() => {})),
      );
      chunkDuration = Math.max(30, Math.floor(chunkDuration * 0.8));
    }
  }

  throw new Error("Unable to generate chunks within size limit after trying multiple formats");
}

interface Preferences {
  deepgramApiKey: string;
  deepgramModel: string;
  smartFormat: boolean;
  detectLanguage: boolean;
  maxChunkSizeMB?: number;
  autoOpenTranscription?: boolean;
  defaultCopyFormat?: string;
  enableAudioValidation?: boolean;
  historyLimit?: number;
  showDetailedProgress?: boolean;
  notificationLevel?: string;
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

  let audioValidation: { isValid: boolean; format?: { ext: string; mime: string }; error?: string } = { isValid: true };

  // Validate the audio file if enabled
  if (preferences.enableAudioValidation !== false) {
    progressCallback?.("validation", 0, 5, "Validating audio file...");
    audioValidation = await validateAudioFile(filePath);
    if (!audioValidation.isValid) {
      throw new Error(`Audio file validation failed: ${audioValidation.error}`);
    }
    console.log(`✅ Audio file validated: ${audioValidation.format?.ext} (${audioValidation.format?.mime})`);
  } else {
    progressCallback?.("validation", 0, 5, "Skipping audio validation...");
  }

  progressCallback?.("validation", 1, 5, "Validating API key...");
  const isValidApiKey = await validateApiKey(preferences.deepgramApiKey);

  if (!isValidApiKey) {
    throw new Error("Invalid API key");
  }

  progressCallback?.("preparation", 2, 5, "Preparing audio processing...");
  const ffmpegPath = await getFfmpegPath();
  const deepgram = createClient(preferences.deepgramApiKey);
  const tempDir = await fs.promises.mkdtemp(path.join(tmpdir(), "voxscribe-chunks-"));

  try {
    let overallSize = 0;

    console.log(`Creating temporary directory for chunks: ${tempDir}`);
    progressCallback?.("chunking", 3, 5, "Chunking audio file...");

    // Show toast notifications based on preference
    if (preferences.notificationLevel === "all" || preferences.notificationLevel === undefined) {
      showToast({ style: Toast.Style.Animated, title: "Preparing audio..." });
    }

    const fileStats = await fs.promises.stat(filePath);
    const fileSize = fileStats.size;
    const estimatedChunks = Math.max(1, Math.ceil(fileSize / targetChunkSizeBytes));
    progressCallback?.(
      "preparation",
      2,
      5,
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

    const chunkFiles = await segmentAudioWithRetry(
      ffmpegPath,
      filePath,
      tempDir,
      chunkDuration,
      targetChunkSizeBytes,
      signal,
    );
    if (signal.aborted) throw new AbortError();

    console.log(`Audio chunking complete with ${chunkFiles.length} chunk(s).`);
    if (chunkFiles.length === 0) {
      throw new Error("No audio chunks were generated. Check the input file and FFmpeg setup.");
    }

    let combinedTranscription = "";
    const rawResults = [];
    const transcriptionTasks: (() => Promise<{ index: number; transcription: string; rawData: unknown }>)[] = [];
    let processedCount = 0;

    progressCallback?.(
      "transcription",
      4,
      5,
      `Transcribing ${chunkFiles.length} audio chunk${chunkFiles.length > 1 ? "s" : ""}...`,
    );
    if (preferences.notificationLevel === "all" || preferences.notificationLevel === undefined) {
      showToast({
        style: Toast.Style.Animated,
        title: "Transcribing audio",
        message: `Processing ${chunkFiles.length} chunk(s)...`,
      });
    }

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
          progressCallback?.("transcription", 4, 5, `Transcribed ${processedCount} of ${chunkFiles.length} chunks`);

          if (preferences.notificationLevel === "all" || preferences.notificationLevel === undefined) {
            await showToast({
              style: Toast.Style.Animated,
              title: "Transcribing audio",
              message: `Processed ${processedCount} of ${chunkFiles.length} chunks`,
            });
          }

          if (error) {
            console.error(`Error transcribing chunk ${chunkFileName}:`, error);
            return { index, transcription: `[Transcription Error for chunk ${index + 1}]`, rawData: null };
          }
          if (result?.results?.channels?.[0]?.alternatives?.[0]?.transcript) {
            const transcription = result.results.channels[0].alternatives[0].transcript;
            console.log(`✅ Chunk ${index + 1} transcription successful:`, {
              transcriptLength: transcription.length,
              hasRawData: !!result,
              resultStructure: result ? Object.keys(result) : "null",
            });
            return {
              index,
              transcription: transcription,
              rawData: result,
            };
          } else {
            console.warn(`❌ No transcript returned for chunk ${chunkFileName}:`, {
              hasResult: !!result,
              resultStructure: result ? Object.keys(result) : "null",
            });
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
        return createTranscriptionTask(chunkFileName, chunkFilePath, index);
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

    // Ensure all transcription tasks have completed before cleanup
    if (results && results.length === transcriptionTasks.length) {
      console.log("All transcription tasks completed successfully");
    }

    results.sort((a, b) => a.index - b.index);

    console.log(`🔍 Processing ${results.length} transcription results:`);
    for (const result of results) {
      console.log(`📝 Result ${result.index}:`, {
        hasTranscription: !!result.transcription,
        transcriptionLength: result.transcription?.length || 0,
        hasRawData: !!result.rawData,
        transcriptionPreview: result.transcription?.substring(0, 50) || "None",
      });

      combinedTranscription += result.transcription + " ";
      if (result.rawData) {
        console.log(`✅ Adding rawData for chunk ${result.index}`);
        rawResults.push(result.rawData);
      } else {
        console.log(`❌ No rawData for chunk ${result.index}`);
      }
    }

    console.log(`📊 Final rawResults summary:`, {
      totalResults: results.length,
      rawDataCount: rawResults.length,
      rawResultsIsArray: Array.isArray(rawResults),
      combinedTranscriptionLength: combinedTranscription.length,
    });

    progressCallback?.("completion", 5, 5, "Transcription completed successfully!");

    // Show completion notification based on preference
    if (preferences.notificationLevel !== "none" && preferences.notificationLevel !== "errors") {
      await showToast({ style: Toast.Style.Success, title: "Transcription complete!" });
    }

    // Get detailed audio metadata
    const audioMetadata = await getDetailedAudioMetadata(filePath);

    // Serialize rawResults with error handling
    let serializedRawData: string;
    try {
      serializedRawData = JSON.stringify(rawResults);
      console.log(`✅ JSON serialization successful:`, {
        rawResultsLength: rawResults.length,
        serializedLength: serializedRawData.length,
        firstChar: serializedRawData[0],
        lastChar: serializedRawData[serializedRawData.length - 1],
      });
    } catch (serializationError) {
      console.error(`❌ JSON serialization failed:`, serializationError);
      console.log(`Fallback: using empty array for rawData`);
      serializedRawData = "[]";
    }

    return {
      transcription: combinedTranscription.trim(),
      rawData: serializedRawData,
      chunkedFileInfo: {
        size: overallSize,
        extension: CHUNK_FORMAT,
      },
      audioMetadata: audioMetadata || undefined,
      originalFileInfo: {
        size: fileSize,
        format: audioValidation.format?.ext || "unknown",
        isValidAudio: audioValidation.isValid,
      },
    };
  } finally {
    // Add a small delay to ensure all async file operations are complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    console.log(`Attempting to remove temporary directory: ${tempDir}`);
    await fs.promises
      .rm(tempDir, { recursive: true, force: true })
      .catch((e) => console.error(`Failed to delete temp directory ${tempDir}:`, e));
    console.log("Temporary directory removed.");
  }
}
