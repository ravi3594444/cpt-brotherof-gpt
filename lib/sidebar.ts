// The desktop sidebar is open or folded to an icon rail, remembered on this
// device. Phones always use the drawer and ignore this.
export const SIDEBAR_STORAGE_KEY = "scout.sidebar";
// Set on <html> before the app loads, so the first paint already shows the rail.
export const SIDEBAR_BOOT_ATTRIBUTE = "data-scout-sidebar";

type DeviceStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const deviceStorage = (): DeviceStorage => localStorage;

/** Whether the desktop sidebar starts open: yes, unless this device saved it collapsed. */
export function readSidebarOpen(storage: () => Pick<DeviceStorage, "getItem"> = deviceStorage) {
  try {
    return storage().getItem(SIDEBAR_STORAGE_KEY) !== "collapsed";
  } catch {
    return true;
  }
}

export function saveSidebarOpen(open: boolean, storage: () => Pick<DeviceStorage, "setItem"> = deviceStorage) {
  try {
    storage().setItem(SIDEBAR_STORAGE_KEY, open ? "expanded" : "collapsed");
  } catch {
    /* local storage can be disabled; the choice lasts for this visit */
  }
}

/** Runs in <head> before the page paints; the app removes the mark once it has loaded. */
export const SIDEBAR_BOOT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)})==="collapsed")document.documentElement.setAttribute(${JSON.stringify(SIDEBAR_BOOT_ATTRIBUTE)},"collapsed")}catch(e){}`;
