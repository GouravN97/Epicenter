// Desktop notifications for new incidents (the browser's Notification API). Off until the user turns them
// on, because the browser only shows its permission prompt in answer to a click. Clicking a notification
// brings the tab forward and opens that incident's room, where the map marks the epicenter.
//
// Limits of the API, not of this code: the app has to be open in a tab (no service worker, so nothing arrives
// once it is closed), and browsers only allow notifications on https or localhost.
import { create } from 'zustand';
import { SERVICE_BY_ID, isServiceId, type IncidentDTO } from '@epicenter/shared';

export const NOTIFY_STORAGE_KEY = 'epicenter.notify';

/** unsupported: no API here · blocked: denied in the browser · off / on: the user's choice. */
export type NotifyStatus = 'unsupported' | 'blocked' | 'off' | 'on';

export function resolveNotifyStatus(supported: boolean, permission: NotificationPermission | null, wanted: boolean): NotifyStatus {
  if (!supported || permission === null) return 'unsupported';
  if (permission === 'denied') return 'blocked';
  return wanted && permission === 'granted' ? 'on' : 'off';
}

export interface NotificationContent {
  title: string;
  body: string;
  /** One notification per incident: a second one with the same tag replaces the first. */
  tag: string;
  /** In-app path opened on click. */
  to: string;
}

export function notificationContent(i: IncidentDTO): NotificationContent {
  const epicenter = i.epicenter ? (isServiceId(i.epicenter) ? SERVICE_BY_ID[i.epicenter].name : i.epicenter) : null;
  const n = i.affected.length;
  const scope = `${n} service${n === 1 ? '' : 's'} alerting`;
  return {
    title: epicenter ? `New incident: ${epicenter}` : 'New incident',
    body: epicenter ? `${i.title || `Epicenter ${epicenter}`}\n${scope}. Click to open the incident room.` : `Alerts are being correlated. ${scope}.`,
    tag: `epicenter-incident-${i.id}`,
    to: `/incidents/${i.id}`,
  };
}

const supported = (): boolean => typeof window !== 'undefined' && 'Notification' in window;
const permission = (): NotificationPermission | null => (supported() ? Notification.permission : null);

function readWanted(): boolean {
  try {
    return localStorage.getItem(NOTIFY_STORAGE_KEY) === 'on';
  } catch {
    return false; // storage blocked: notifications still work for this visit once enabled
  }
}
function writeWanted(on: boolean): void {
  try {
    localStorage.setItem(NOTIFY_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* not remembered */
  }
}

interface NotifyState {
  status: NotifyStatus;
  /** Asks the browser for permission if needed. Call from a click handler. */
  enable(): Promise<void>;
  disable(): void;
}

export const useDesktopNotify = create<NotifyState>((set) => ({
  status: resolveNotifyStatus(supported(), permission(), typeof window !== 'undefined' && readWanted()),
  async enable() {
    if (!supported()) return;
    let result = Notification.permission;
    if (result === 'default') {
      try {
        result = await Notification.requestPermission();
      } catch {
        result = 'denied'; // an insecure page (plain http) refuses the request
      }
    }
    writeWanted(result === 'granted');
    set({ status: resolveNotifyStatus(true, result, result === 'granted') });
  },
  disable() {
    writeWanted(false);
    set({ status: resolveNotifyStatus(supported(), permission(), false) });
  },
}));

let navigate: ((to: string) => void) | null = null;
/** Registered by the app root, so this module does not import the router (which imports every page). */
export function setNotificationNavigator(fn: (to: string) => void): void {
  navigate = fn;
}

/** Shows a desktop notification for a new incident. Does nothing unless they are on and still permitted. */
export function notifyIncident(incident: IncidentDTO): void {
  if (useDesktopNotify.getState().status !== 'on' || permission() !== 'granted') return;
  const c = notificationContent(incident);
  try {
    const n = new Notification(c.title, { body: c.body, tag: c.tag });
    n.onclick = () => {
      window.focus();
      navigate?.(c.to);
      n.close();
    };
  } catch {
    // Some mobile browsers expose the API but only allow notifications from a service worker.
  }
}
