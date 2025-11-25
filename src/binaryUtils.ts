import { exec } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

/**
 * Checks if a binary is available in the system PATH or common locations.
 * @param binaryName The name of the binary to check (e.g., "ffmpeg", "ffprobe").
 * @returns The path to the binary if found, or throws an error if not found.
 */
export async function getBinaryPath(binaryName: string): Promise<string> {
  try {
    // Check if binary is in the PATH and executable
    await execPromise(`${binaryName} -version`);
    return binaryName;
  } catch (error) {
    // If not in PATH, check common Homebrew paths
    const commonPaths = [
      `/opt/homebrew/bin/${binaryName}`,
      `/usr/local/bin/${binaryName}`,
      `/usr/bin/${binaryName}`, // Also check standard system bin
    ];

    for (const path of commonPaths) {
      try {
        await execPromise(`${path} -version`);
        return path;
      } catch (e) {
        // Continue to the next path
      }
    }
  }

  throw new Error(`${binaryName} not found. Please install it and ensure it is in your system's PATH.`);
}

/**
 * specific helper for ffmpeg
 */
export async function getFfmpegPath(): Promise<string> {
  return getBinaryPath("ffmpeg");
}

/**
 * specific helper for ffprobe
 */
export async function getFfprobePath(): Promise<string> {
  return getBinaryPath("ffprobe");
}

/**
 * Safe version of getFfprobePath that returns null if not found
 */
export async function getSafeFfprobePath(): Promise<string | null> {
  try {
    return await getBinaryPath("ffprobe");
  } catch (e) {
    return null;
  }
}
