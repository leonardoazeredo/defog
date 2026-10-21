export const COPY = {
  zipOnly: "Cross the Fog can only import .zip backups.",
  notABackup: "That file isn't a Fog of World backup. Your saved fog is unchanged.",
  importFailed: "That backup couldn't be opened. Your saved fog is unchanged.",
  importing: "Importing your fog…",
  exportFailed: "Couldn't share the file.",
  pressBackAgain: "Press back again to exit",
  replaceTitle: (name: string) => `Replace your saved fog with ${name}?`,
  replace: "Replace",
  clearTitle: "Clear saved fog?",
  clearMessage: "You'll need to import a backup again to see your fog.",
  clear: "Clear",
  cancel: "Cancel",
  historyOpenFailed:
    "Your history could not be opened. Restart the app; if it persists, restore a backup.",
  routeNotSent: "The route couldn't be saved for the watch.",
  activityDeleteFailed: "Couldn't delete that activity.",
  historyKeyLost: "Your history key is gone; restore a backup to get it back",
} as const;
