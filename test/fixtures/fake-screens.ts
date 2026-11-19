// V4.5 Screen companion: fake windows the reference watch (src/screen-companion.ts) and the Windows
// app's port (desktop/windows/src/screen-watch.cpp, run by ScreenWatchChecks) are both
// checked on. No real screen is ever read: each look is what the app would have read from one window.
import type { ScreenLook } from '../../src/screen-companion.ts';

export interface FakeScreen {
  name: string;
  look: ScreenLook;
  /** What one look at it finds ('' = nothing). */
  kind: '' | 'error' | 'form';
  line?: string;
}

export const FAKE_SCREENS: FakeScreen[] = [
  {
    name: 'error dialog',
    look: { title: 'Invoice Maker', app: 'Invoice Maker', dialog: true, texts: ['Could not save "march.inv": the disk is full.', 'OK'] },
    kind: 'error',
    line: 'Could not save "march.inv": the disk is full.',
  },
  {
    name: 'not responding title',
    look: { title: 'Photo Album (Not Responding)', app: 'Photo Album', dialog: false, texts: ['Album', 'Edit'] },
    kind: 'error',
    line: 'Photo Album (Not Responding)',
  },
  {
    name: 'german error dialog',
    look: { title: 'Rechnung', app: 'Rechnung', dialog: true, texts: ['Speichern fehlgeschlagen.', 'OK'] },
    kind: 'error',
    line: 'Speichern fehlgeschlagen.',
  },
  {
    name: 'french dialog with accents',
    look: { title: 'Factures', app: 'Factures', dialog: true, texts: ['Échec de l’envoi du fichier.', 'Fermer'] },
    kind: 'error',
    line: 'Échec de l’envoi du fichier.',
  },
  {
    name: 'stuck form',
    look: { title: 'Sign up - Club', app: 'Club', dialog: false, texts: ['Name', 'Email', 'Email is required.', 'Send'] },
    kind: 'form',
    line: 'Email is required.',
  },
  {
    name: 'plain document mentioning errors',
    look: { title: 'notes.txt - Editor', app: 'Editor', dialog: false, texts: ['Things to fix: the error on page 2 and the failed backup.'] },
    kind: '',
  },
  {
    name: 'a word inside another word',
    look: { title: 'Terror films', app: 'Films', dialog: true, texts: ['Terrorbird', 'OK'] },
    kind: '',
  },
  {
    name: 'long text in a dialog is not read',
    look: { title: 'Readme', app: 'Readme', dialog: true, texts: ['x'.repeat(290) + ' error ' + 'y'.repeat(20)] },
    kind: '',
  },
  {
    name: 'key-shaped text is masked in the line',
    look: { title: 'Deploy', app: 'Deploy', dialog: true, texts: ['Error: key sk-' + 'A'.repeat(20) + ' was refused'] },
    kind: 'error',
    line: 'Error: key [hidden] was refused',
  },
  {
    name: 'hidden window (password manager)',
    look: { title: 'KeePass - Error', app: 'KeePass', dialog: true, texts: ['Invalid master key.'], hidden: 'password manager' },
    kind: '',
  },
  {
    name: 'Sara\'s own window',
    look: { title: 'Sara', app: 'Sara', dialog: true, texts: ['Error: the server is away.'], own: true },
    kind: '',
  },
];
