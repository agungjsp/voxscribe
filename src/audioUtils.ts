import { fileTypeFromFile } from "file-type";
import { exec } from "child_process";
import { promisify } from "util";
import { getSafeFfprobePath } from "./binaryUtils";

const execPromise = promisify(exec);

export interface AudioMetadata {
  format: string;
  duration: number;
  bitrate: number;
  sampleRate: number;
  channels: number;
  codec: string;
  size: number;
  isLossless: boolean;
}

export interface SupportedAudioFormat {
  extension: string;
  mimeTypes: string[];
  description: string;
  isLossless: boolean;
}

export const SUPPORTED_AUDIO_FORMATS: SupportedAudioFormat[] = [
  {
    extension: "mp3",
    mimeTypes: ["audio/mpeg", "audio/mp3"],
    description: "MPEG Audio Layer 3",
    isLossless: false,
  },
  {
    extension: "wav",
    mimeTypes: ["audio/wav", "audio/wave", "audio/x-wav"],
    description: "Waveform Audio File Format",
    isLossless: true,
  },
  {
    extension: "flac",
    mimeTypes: ["audio/flac", "audio/x-flac"],
    description: "Free Lossless Audio Codec",
    isLossless: true,
  },
  {
    extension: "aac",
    mimeTypes: ["audio/aac", "audio/x-aac", "audio/aacp"],
    description: "Advanced Audio Codec",
    isLossless: false,
  },
  {
    extension: "ogg",
    mimeTypes: ["audio/ogg", "application/ogg", "audio/vorbis"],
    description: "Ogg Vorbis",
    isLossless: false,
  },
  {
    extension: "opus",
    mimeTypes: ["audio/opus"],
    description: "Opus Audio Codec",
    isLossless: false,
  },
  {
    extension: "m4a",
    mimeTypes: ["audio/m4a", "audio/mp4", "audio/x-m4a", "video/mp4", "audio/aac"],
    description: "MPEG-4 Audio",
    isLossless: false,
  },
  {
    extension: "wma",
    mimeTypes: ["audio/x-ms-wma", "audio/wma"],
    description: "Windows Media Audio",
    isLossless: false,
  },
  {
    extension: "aiff",
    mimeTypes: ["audio/aiff", "audio/x-aiff"],
    description: "Audio Interchange File Format",
    isLossless: true,
  },
  {
    extension: "webm",
    mimeTypes: ["audio/webm", "video/webm"],
    description: "WebM Audio",
    isLossless: false,
  },
  {
    extension: "mp4",
    mimeTypes: ["video/mp4", "audio/mp4"],
    description: "MPEG-4 Video/Audio",
    isLossless: false,
  },
  {
    extension: "mkv",
    mimeTypes: ["video/x-matroska", "audio/x-matroska"],
    description: "Matroska",
    isLossless: false,
  },
  {
    extension: "mov",
    mimeTypes: ["video/quicktime"],
    description: "QuickTime",
    isLossless: false,
  },
  {
    extension: "avi",
    mimeTypes: ["video/x-msvideo", "video/avi"],
    description: "AVI",
    isLossless: false,
  },
];

export async function detectAudioFormat(filePath: string): Promise<{ ext: string; mime: string } | null> {
  try {
    const fileType = await fileTypeFromFile(filePath);
    if (fileType && isAudioFormat(fileType.mime)) {
      return fileType;
    }
    return null;
  } catch (error) {
    console.error("Error detecting file type:", error);
    return null;
  }
}

export function isAudioFormat(mimeType: string): boolean {
  return SUPPORTED_AUDIO_FORMATS.some((format) => format.mimeTypes.includes(mimeType));
}

export function isSupportedAudioExtension(extension: string): boolean {
  return SUPPORTED_AUDIO_FORMATS.some((format) => format.extension === extension.toLowerCase());
}

export function getAudioFormatInfo(extension: string): SupportedAudioFormat | null {
  return SUPPORTED_AUDIO_FORMATS.find((format) => format.extension === extension.toLowerCase()) || null;
}

export async function getDetailedAudioMetadata(filePath: string): Promise<AudioMetadata | null> {
  try {
    // Check if ffprobe is available
    const ffprobePath = await getSafeFfprobePath();
    if (!ffprobePath) {
      console.warn("ffprobe not found, skipping detailed audio metadata extraction");
      return null;
    }

    // Use ffprobe to get detailed audio metadata
    const { stdout } = await execPromise(
      `"${ffprobePath}" -v quiet -print_format json -show_format -show_streams "${filePath}"`,
    );

    const data = JSON.parse(stdout);
    const audioStream = data.streams?.find((stream: { codec_type?: string }) => stream.codec_type === "audio");
    const format = data.format;

    if (!audioStream || !format) {
      return null;
    }

    // Detect if format is lossless
    const formatInfo = getAudioFormatInfo(format.format_name?.split(",")[0] || "");
    const isLossless =
      formatInfo?.isLossless || ["flac", "wav", "aiff", "alac"].includes(audioStream.codec_name?.toLowerCase() || "");

    return {
      format: format.format_long_name || format.format_name || "Unknown",
      duration: parseFloat(format.duration) || 0,
      bitrate: parseInt(format.bit_rate) || parseInt(audioStream.bit_rate) || 0,
      sampleRate: parseInt(audioStream.sample_rate) || 0,
      channels: parseInt(audioStream.channels) || 0,
      codec: audioStream.codec_long_name || audioStream.codec_name || "Unknown",
      size: parseInt(format.size) || 0,
      isLossless,
    };
  } catch (error) {
    console.error("Error getting audio metadata:", error);
    return null;
  }
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "Unknown";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

export function formatBitrate(bitrate: number): string {
  if (!bitrate || bitrate <= 0) return "Unknown";

  if (bitrate >= 1000000) {
    return `${(bitrate / 1000000).toFixed(1)} Mbps`;
  }
  return `${Math.round(bitrate / 1000)} kbps`;
}

export function formatSampleRate(sampleRate: number): string {
  if (!sampleRate || sampleRate <= 0) return "Unknown";

  if (sampleRate >= 1000) {
    return `${(sampleRate / 1000).toFixed(1)} kHz`;
  }
  return `${sampleRate} Hz`;
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "Unknown";

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export async function validateAudioFile(filePath: string): Promise<{
  isValid: boolean;
  format?: { ext: string; mime: string };
  error?: string;
}> {
  try {
    const fs = await import("fs");
    const pathModule = await import("path");

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return { isValid: false, error: "File does not exist" };
    }

    const stats = await fs.promises.stat(filePath);
    if (stats.size === 0) {
      return { isValid: false, error: "File is empty" };
    }

    // Try to detect format via file-type library
    const format = await detectAudioFormat(filePath);

    // If file-type doesn't recognize it, try ffprobe as fallback
    if (!format) {
      const metadata = await getDetailedAudioMetadata(filePath);
      if (metadata && metadata.duration > 0) {
        // ffprobe could read it, so it's valid - use extension as format
        const ext = pathModule.extname(filePath).slice(1).toLowerCase();
        return {
          isValid: true,
          format: { ext: ext || "unknown", mime: "audio/unknown" },
        };
      }
      return { isValid: false, error: "Unsupported audio format" };
    }

    // Verify it's actually playable by checking metadata
    const metadata = await getDetailedAudioMetadata(filePath);
    if (!metadata) {
      // If ffprobe fails but file-type detected audio, still allow it
      // FFmpeg will handle conversion during chunking
      return { isValid: true, format };
    }

    return { isValid: true, format };
  } catch (error) {
    return { isValid: false, error: `Validation failed: ${String(error)}` };
  }
}
