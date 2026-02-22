import { window } from "vscode";
import { logger } from "../logger";
import { getSnapshotManager } from "../Storage/snapshotManager";
import {
  clearDecorationsForFile,
  refreshAllDecorations,
} from "../Storage/snapshotDecorations";
import * as fs from "fs";

/** Minimal interface so SnapshotHandler can post messages to webview */
export interface SnapshotHost {
  postMessage(msg: any): void;
}

/**
 * Handles snapshot confirm/revert operations and dashboard updates.
 * Extracted from ChatViewProvider to reduce god-class size.
 */
export class SnapshotHandler {
  constructor(private host: SnapshotHost) {}

  async confirmSnapshot(id: string): Promise<void> {
    try {
      const sm = getSnapshotManager();
      const snapshots = sm.getPendingSnapshots();
      const snapshot = snapshots.find((s) => s.id === id);
      const success = await sm.confirmSnapshot(id);
      if (success && snapshot) {
        clearDecorationsForFile(snapshot.filePath);
        this.sendUpdate();
        window.showInformationMessage(
          `Изменения в ${snapshot.fileName} подтверждены`
        );
      }
    } catch (e) {
      logger.error("Failed to confirm snapshot", e);
      window.showErrorMessage("Не удалось подтвердить изменения");
    }
  }

  async revertSnapshot(id: string): Promise<void> {
    try {
      const sm = getSnapshotManager();
      const snapshots = sm.getPendingSnapshots();
      const snapshot = snapshots.find((s) => s.id === id);
      const success = await sm.rollbackSnapshot(id);
      if (success && snapshot) {
        clearDecorationsForFile(snapshot.filePath);
        refreshAllDecorations();
        this.sendUpdate();
        window.showInformationMessage(
          `Изменения в ${snapshot.fileName} отменены`
        );
      }
    } catch (e) {
      logger.error("Failed to revert snapshot", e);
      window.showErrorMessage("Не удалось откатить изменения");
    }
  }

  async confirmFile(filePath: string): Promise<void> {
    try {
      const sm = getSnapshotManager();
      const count = await sm.confirmFile(filePath);
      if (count > 0) {
        clearDecorationsForFile(filePath);
        refreshAllDecorations();
        this.sendUpdate();
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        window.showInformationMessage(
          `Все изменения в ${fileName} подтверждены (${count})`
        );
      }
    } catch (e) {
      logger.error("Failed to confirm file", e);
      window.showErrorMessage(
        "Не удалось подтвердить изменения в файле"
      );
    }
  }

  async revertFile(filePath: string): Promise<void> {
    try {
      const sm = getSnapshotManager();
      const count = await sm.rollbackFile(filePath);
      if (count > 0) {
        clearDecorationsForFile(filePath);
        refreshAllDecorations();
        this.sendUpdate();
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        window.showInformationMessage(
          `Все изменения в ${fileName} отменены (${count})`
        );
      }
    } catch (e) {
      logger.error("Failed to revert file", e);
      window.showErrorMessage(
        "Не удалось откатить изменения в файле"
      );
    }
  }

  async confirmAll(): Promise<void> {
    try {
      const sm = getSnapshotManager();
      await sm.confirmAll();
      refreshAllDecorations();
      this.sendUpdate();
      window.showInformationMessage("Все изменения подтверждены");
    } catch (e) {
      logger.error("Failed to confirm all snapshots", e);
      window.showErrorMessage(
        "Не удалось подтвердить все изменения"
      );
    }
  }

  async revertAll(): Promise<void> {
    try {
      const sm = getSnapshotManager();
      await sm.rollbackAll();
      refreshAllDecorations();
      this.sendUpdate();
      window.showInformationMessage("Все изменения отменены");
    } catch (e) {
      logger.error("Failed to revert all snapshots", e);
      window.showErrorMessage(
        "Не удалось откатить все изменения"
      );
    }
  }

  /** Send full snapshot dashboard state to the webview */
  sendUpdate(): void {
    const sm = getSnapshotManager();
    const snapshots = sm.getPendingSnapshots();

    // Auto-clean snapshots for files that were deleted externally
    const deletedSnapshots = snapshots.filter(s => !fs.existsSync(s.filePath));
    for (const s of deletedSnapshots) {
      logger.log(`[SnapshotHandler] Auto-confirming snapshot for deleted file: ${s.filePath}`);
      clearDecorationsForFile(s.filePath);
      sm.confirmSnapshot(s.id).catch(err => {
        logger.error(`Failed to auto-confirm snapshot for deleted file ${s.filePath}`, err);
      });
    }

    // Get remaining snapshots after cleanup
    const remaining = deletedSnapshots.length > 0 ? sm.getPendingSnapshots() : snapshots;
    const summary = sm.getSummary();

    this.host.postMessage({
      type: "updatePendingSnapshots",
      data: {
        snapshots: remaining.map((s) => ({
          id: s.id,
          filePath: s.filePath,
          fileName: s.fileName,
          tool: s.tool,
          linesAdded: s.totalLinesAdded,
          linesRemoved: s.totalLinesRemoved,
          timestamp: s.updatedAt,
          changes: s.changes,
        })),
        stats: {
          filesChanged: summary.totalFiles,
          totalAdded: summary.totalAdded,
          totalRemoved: summary.totalRemoved,
        },
      },
    });
  }
}
