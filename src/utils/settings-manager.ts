/**
 * Settings Manager
 * 
 * Handles persistent configuration for the NotebookLM MCP Server.
 * Manages profiles, disabled tools, and environment variable overrides.
 */

import fs from "fs/promises";
import { existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

export type ProfileName = "minimal" | "standard" | "full";

export interface CustomSettings {
  alwaysIncludeSources: boolean;
}

export interface Settings {
  profile: ProfileName;
  disabledTools: string[];
  customSettings?: CustomSettings;
}

const DEFAULT_ALWAYS_INCLUDE_SOURCES = true;

const DEFAULT_SETTINGS: Settings = {
  profile: "full",
  disabledTools: [],
  customSettings: {
    alwaysIncludeSources: DEFAULT_ALWAYS_INCLUDE_SOURCES,
  },
};

const PROFILES: Record<ProfileName, string[]> = {
  minimal: [
    "ask_question",
    "get_health",
    "list_notebooks",
    "select_notebook",
    "get_notebook" // Added as it is read-only and useful
  ],
  standard: [
    "ask_question",
    "get_health",
    "list_notebooks",
    "select_notebook",
    "get_notebook",
    "setup_auth",
    "list_sessions",
    "add_notebook",
    "update_notebook",
    "search_notebooks"
  ],
  full: ["*"] // All tools
};

export class SettingsManager {
  private settingsPath: string;
  private settings: Settings;

  constructor() {
    // Use the config directory from env-paths defined in config.ts
    this.settingsPath = path.join(CONFIG.configDir, "settings.json");
    this.settings = this.loadSettings();
  }

  /**
   * Load settings from file, falling back to defaults
   */
  private loadSettings(): Settings {
    try {
      // Ensure config dir exists
      if (!existsSync(CONFIG.configDir)) {
        mkdirSync(CONFIG.configDir, { recursive: true });
      }

      if (existsSync(this.settingsPath)) {
        const data = readFileSync(this.settingsPath, "utf-8");
        const parsed = JSON.parse(data) as Partial<Settings>;
        return this.normalizeSettings(parsed);
      }
    } catch (error) {
      log.warning(`⚠️  Failed to load settings: ${error}. Using defaults.`);
    }
    return this.normalizeSettings({});
  }

  private normalizeSettings(settings: Partial<Settings>): Settings {
    const customSettings = (settings.customSettings || {}) as Partial<CustomSettings>;

    return {
      profile: settings.profile || DEFAULT_SETTINGS.profile,
      disabledTools: Array.isArray(settings.disabledTools)
        ? settings.disabledTools
        : DEFAULT_SETTINGS.disabledTools,
      customSettings: {
        alwaysIncludeSources:
          typeof customSettings.alwaysIncludeSources === "boolean"
            ? customSettings.alwaysIncludeSources
            : DEFAULT_ALWAYS_INCLUDE_SOURCES,
      },
    };
  }

  private parseBooleanOverride(value: string | undefined): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }

    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1") {
      return true;
    }
    if (lower === "false" || lower === "0") {
      return false;
    }

    return undefined;
  }

  /**
   * Save current settings to file
   */
  async saveSettings(newSettings: Partial<Settings>): Promise<void> {
    const mergedCustomSettings =
      newSettings.customSettings !== undefined
        ? {
            ...(this.settings.customSettings || {}),
            ...newSettings.customSettings,
          }
        : this.settings.customSettings;

    this.settings = this.normalizeSettings({
      ...this.settings,
      ...newSettings,
      customSettings: mergedCustomSettings,
    });
    try {
      await fs.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
    } catch (error) {
      throw new Error(`Failed to save settings: ${error}`);
    }
  }

  /**
   * Get effective configuration (merging File settings with Env Vars)
   */
  getEffectiveSettings(): Settings {
    const envProfile = process.env.NOTEBOOKLM_PROFILE as ProfileName;
    const envDisabled = process.env.NOTEBOOKLM_DISABLED_TOOLS;
    const envAlwaysIncludeSources = this.parseBooleanOverride(
      process.env.NOTEBOOKLM_ALWAYS_INCLUDE_SOURCES
    );

    const effectiveProfile = (envProfile && PROFILES[envProfile]) ? envProfile : this.settings.profile;
    
    let effectiveDisabled = [...this.settings.disabledTools];
    if (envDisabled) {
      const envDisabledList = envDisabled.split(",").map(t => t.trim());
      effectiveDisabled = [...new Set([...effectiveDisabled, ...envDisabledList])];
    }

    return {
      profile: effectiveProfile,
      disabledTools: effectiveDisabled,
      customSettings: {
        ...(this.settings.customSettings || {
          alwaysIncludeSources: DEFAULT_ALWAYS_INCLUDE_SOURCES,
        }),
        ...(envAlwaysIncludeSources !== undefined
          ? { alwaysIncludeSources: envAlwaysIncludeSources }
          : {}),
      },
    };
  }

  getAlwaysIncludeSources(): boolean {
    return this.getEffectiveSettings().customSettings?.alwaysIncludeSources ??
      DEFAULT_ALWAYS_INCLUDE_SOURCES;
  }

  /**
   * Filter tools based on effective configuration
   */
  filterTools(allTools: Tool[]): Tool[] {
    const { profile, disabledTools } = this.getEffectiveSettings();
    const allowedTools = PROFILES[profile];

    return allTools.filter(tool => {
      // 1. Check if allowed by profile (unless profile is full/wildcard)
      if (!allowedTools.includes("*") && !allowedTools.includes(tool.name)) {
        return false;
      }

      // 2. Check if explicitly disabled
      if (disabledTools.includes(tool.name)) {
        return false;
      }

      return true;
    });
  }

  getSettingsPath(): string {
    return this.settingsPath;
  }

  getProfiles(): Record<ProfileName, string[]> {
    return PROFILES;
  }

  getStoredSettings(): Settings {
    return this.normalizeSettings(this.settings);
  }
}
