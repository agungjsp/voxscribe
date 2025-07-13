import { LocalStorage } from "@raycast/api";

export interface TranscriptionHistoryItem {
  filePath: string;
  transcription: string;
  rawData: string;
  compressedFileInfo: {
    size: number;
    extension: string;
  };
  timestamp: number;
}

const HISTORY_KEY = "transcription_history";

export async function saveTranscription(item: TranscriptionHistoryItem): Promise<void> {
  const history = await getTranscriptionHistory();
  history.unshift(item);
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 10))); // Keep only the last 10 items
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
    (historyItem) => historyItem.filePath !== item.filePath || historyItem.timestamp !== item.timestamp
  );
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
}