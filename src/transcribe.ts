import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { getPreferenceValues, showToast, Toast } from "@raycast/api";
import axios from "axios";
import { exec, spawn } from "child_process";
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

interface Preferences {
  deepgramApiKey: string;
  deepgramModel: string;
  smartFormat: boolean;
  detectLanguage: boolean;
}

interface TranscriptionResult {
  transcription: string;
  rawData: string;
  chunkedFileInfo: {
    size: number;
    extension: string;
  };
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

export async function transcribeAudio(filePath: string, signal: AbortSignal): Promise<TranscriptionResult> {
  if (signal.aborted) throw new AbortError();
  const preferences = getPreferenceValues<Preferences>();
  const isValidApiKey = await validateApiKey(preferences.deepgramApiKey);

  if (!isValidApiKey) {
    throw new Error("Invalid API key");
  }

  const ffmpegPath = await getFfmpegPath();
  const deepgram = createClient(preferences.deepgramApiKey);
  const tempDir = await fs.promises.mkdtemp(path.join(tmpdir(), "voxscribe-chunks-"));

  try {
    const outputPattern = path.join(tempDir, `chunk_%03d.${CHUNK_FORMAT}`);
    let overallSize = 0;

    console.log(`Creating temporary directory for chunks: ${tempDir}`);
    showToast({ style: Toast.Style.Animated, title: "Preparing audio..." });

    const segmentCommand = `"${ffmpegPath}" -i "${filePath}" -f segment -segment_time ${CHUNK_DURATION_SECONDS} -c:a pcm_s16le -reset_timestamps 1 -map 0:a -y "${outputPattern}"`;
    console.log(`Executing FFmpeg segment command: ${segmentCommand}`);

    try {
      await execPromise(segmentCommand, { signal });
      console.log("Audio chunking and re-encoding complete.");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("FFmpeg chunking was aborted.");
        throw error;
      }
      console.error("Error during FFmpeg chunking:", error);
      throw new Error(`FFmpeg chunking failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (signal.aborted) throw new AbortError();

    const chunkFiles = (await fs.promises.readdir(tempDir)).filter((f) => f.endsWith(`.${CHUNK_FORMAT}`)).sort();
    console.log(`Found ${chunkFiles.length} chunks to transcribe.`);

    if (chunkFiles.length === 0) {
      throw new Error("No audio chunks were generated. Check the input file and FFmpeg setup.");
    }

    let combinedTranscription = "";
    const rawResults = [];
    const transcriptionTasks = [];
    let processedCount = 0;

    showToast({
      style: Toast.Style.Animated,
      title: "Transcribing audio",
      message: `Processing ${chunkFiles.length} chunk(s)...`,
    });

    for (let i = 0; i < chunkFiles.length; i++) {
      if (signal.aborted) throw new AbortError();
      const chunkFileName = chunkFiles[i];
      const chunkFilePath = path.join(tempDir, chunkFileName);

      const task = async () => {
        console.log(`Transcribing chunk ${i + 1}/${chunkFiles.length}: ${chunkFileName}`);
        try {
          const audioBuffer = await fs.promises.readFile(chunkFilePath);
          overallSize += audioBuffer.length;
          const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
            model: preferences.deepgramModel,
            detect_language: preferences.detectLanguage,
            smart_format: preferences.smartFormat,
          });

          processedCount++;
          await showToast({
            style: Toast.Style.Animated,
            title: "Transcribing audio",
            message: `Processed ${processedCount} of ${chunkFiles.length} chunks`,
          });

          if (error) {
            console.error(`Error transcribing chunk ${chunkFileName}:`, error);
            return { index: i, transcription: `[Transcription Error for chunk ${i + 1}]`, rawData: null };
          }
          if (result?.results?.channels?.[0]?.alternatives?.[0]?.transcript) {
            const transcription = result.results.channels[0].alternatives[0].transcript;
            return {
              index: i,
              transcription: transcription,
              rawData: result,
            };
          } else {
            console.warn(`No transcript returned for chunk ${chunkFileName}`);
            return { index: i, transcription: `[No transcription for chunk ${i + 1}]`, rawData: null };
          }
        } catch (chunkError) {
          console.error(`Failed to process or transcribe chunk ${chunkFileName}:`, chunkError);
          return { index: i, transcription: `[Processing Error for chunk ${i + 1}]`, rawData: null };
        }
      };
      transcriptionTasks.push(task());
    }

    const abortPromise = new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        reject(new AbortError());
      });
    });

    const results = (await Promise.race([Promise.all(transcriptionTasks), abortPromise])) as {
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

export async function transcribeLive(
  onTranscriptionUpdate: (transcription: string) => void,
  signal: AbortSignal,
): Promise<TranscriptionResult> {
  if (signal.aborted) throw new AbortError();
  const preferences = getPreferenceValues<Preferences>();
  const isValidApiKey = await validateApiKey(preferences.deepgramApiKey);

  if (!isValidApiKey) {
    throw new Error("Invalid API key");
  }

  const ffmpegPath = await getFfmpegPath();
  const deepgram = createClient(preferences.deepgramApiKey);

  let combinedTranscription = "";
  const rawResults: unknown[] = [];

  // Set up Deepgram live stream with latest API
  const connection = deepgram.listen.live({
    model: preferences.deepgramModel,
    detect_language: preferences.detectLanguage,
    smart_format: preferences.smartFormat,
    interim_results: true,
    utterance_end_ms: 1000,
  });

  let connectionReady = false;

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log("Deepgram live connection opened");
    connectionReady = true;
  });

  connection.on(LiveTranscriptionEvents.Error, (error) => {
    console.error("Deepgram error:", error);
    connectionReady = false;
    showToast({ 
      style: Toast.Style.Failure, 
      title: "Deepgram Connection Error", 
      message: "Failed to connect to Deepgram. Please check your API key and internet connection." 
    });
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    console.log("Deepgram live connection closed");
    connectionReady = false;
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    if (data.channel?.alternatives?.[0]?.transcript) {
      const update = data.channel.alternatives[0].transcript;
      if (update.trim()) {
        combinedTranscription += update + " ";
        onTranscriptionUpdate(combinedTranscription.trim());
        rawResults.push(data);
      }
    }
  });

  // Wait a moment for the connection to be established
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Spawn FFmpeg with improved error handling and better audio settings
  const ffmpeg = spawn(ffmpegPath, [
    "-f",
    "avfoundation",
    "-i",
    ":0", // Use default microphone
    "-ar",
    "16000", // Sample rate
    "-ac",
    "1", // Mono channel
    "-f",
    "s16le", // Format
    "-acodec",
    "pcm_s16le",
    "-loglevel",
    "error", // Reduce FFmpeg verbosity
    "pipe:1",
  ]);

  ffmpeg.stdout.on("data", (chunk) => {
    if (connectionReady && connection.getReadyState() === 1) {
      connection.send(chunk);
    }
  });

  ffmpeg.stderr.on("data", (data) => {
    const errorMessage = data.toString();
    console.error(`FFmpeg stderr: ${errorMessage}`);

    if (errorMessage.includes("permission") || errorMessage.includes("denied")) {
      showToast({
        style: Toast.Style.Failure,
        title: "Microphone Access Denied",
        message: "Please grant microphone permissions in System Settings > Privacy & Security > Microphone.",
      });
    } else if (errorMessage.includes("No such file") || errorMessage.includes("not found")) {
      showToast({
        style: Toast.Style.Failure,
        title: "Audio Device Not Found",
        message: "Could not access microphone. Please check your audio settings.",
      });
    }
  });

  ffmpeg.on("error", (error) => {
    throw new Error(`FFmpeg error: ${error.message}`);
  });

  ffmpeg.on("close", (code) => {
    if (code !== 0) {
      console.error(`FFmpeg exited with code ${code}`);
    }
  });

  // Optional: Add a maximum session timeout (10 minutes)
  const timeoutId = setTimeout(
    () => {
      if (!signal.aborted) {
        showToast({
          style: Toast.Style.Failure,
          title: "Session Timeout",
          message: "Live transcription stopped after 10 minutes for safety.",
        });
        ffmpeg.kill();
        connection.requestClose();
      }
    },
    10 * 60 * 1000, // 10 minutes
  );

  signal.addEventListener("abort", () => {
    clearTimeout(timeoutId);
    ffmpeg.kill();
    connection.requestClose();
  });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      ffmpeg.kill();
      connection.requestClose();
      resolve({
        transcription: combinedTranscription.trim(),
        rawData: JSON.stringify(rawResults),
        chunkedFileInfo: { size: 0, extension: "live" },
      });
    };

    signal.addEventListener("abort", () => {
      cleanup();
      reject(new AbortError());
    });

    // Handle connection close event for cleanup
    connection.on(LiveTranscriptionEvents.Close, () => {
      if (!signal.aborted) {
        cleanup();
      }
    });

    // Handle connection errors
    connection.on(LiveTranscriptionEvents.Error, (error) => {
      if (!signal.aborted) {
        clearTimeout(timeoutId);
        ffmpeg.kill();
        connection.requestClose();
        reject(new Error(`Deepgram connection failed: ${error.message || 'Unknown error'}`));
      }
    });
  });
}
