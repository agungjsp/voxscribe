import { LocalStorage, getPreferenceValues } from "@raycast/api";
import { AudioMetadata } from "./audioUtils";

export interface TranscriptionHistoryItem {
  filePath: string;
  transcription: string;
  rawData: string;
  compressedFileInfo: {
    size: number;
    extension: string;
  };
  timestamp: number;
  audioMetadata?: AudioMetadata;
  originalFileInfo?: {
    size: number;
    format: string;
    isValidAudio: boolean;
  };
}

const HISTORY_KEY = "transcription_history";

export async function saveTranscription(item: TranscriptionHistoryItem): Promise<void> {
  const preferences = getPreferenceValues<{
    historyLimit?: string;
  }>();

  const historyLimit = parseInt(preferences.historyLimit || "10");
  const maxItems = historyLimit === -1 ? undefined : historyLimit;

  const history = await getTranscriptionHistory();
  history.unshift(item);

  const trimmedHistory = maxItems ? history.slice(0, maxItems) : history;
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(trimmedHistory));
}

export async function getTranscriptionHistory(): Promise<TranscriptionHistoryItem[]> {
  const historyString = await LocalStorage.getItem<string>(HISTORY_KEY);
  return historyString ? JSON.parse(historyString) : [];
}

export async function clearTranscriptionHistory(): Promise<void> {
  await LocalStorage.removeItem(HISTORY_KEY);
}

export async function removeTranscriptionItem(item: TranscriptionHistoryItem): Promise<void> {
  const history = await getTranscriptionHistory();
  const updatedHistory = history.filter(
    (historyItem) => historyItem.filePath !== item.filePath || historyItem.timestamp !== item.timestamp,
  );
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
}
