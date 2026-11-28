// The journal's files: segment-1.log, segment-2.log, … in one folder (docs/JOURNAL.md).
// Records are appended to the newest segment; when it holds segmentSize records the next one is started.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeSegment, encode, JournalError } from './codec.js';

const SEGMENT = /^segment-(\d+)\.log$/;

export const segmentName = (n) => `segment-${n}.log`;
export const segmentNumber = (name) => Number(SEGMENT.exec(name)?.[1] ?? NaN);

export class SegmentStore {
  constructor(dir, segmentSize, log) {
    this.dir = dir;
    this.segmentSize = segmentSize;
    this.log = log;
    this.current = 0;
    this.count = 0;
  }

  /** The segment files, oldest first. */
  list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => SEGMENT.test(name))
      .sort((a, b) => segmentNumber(a) - segmentNumber(b));
  }

  read(name) {
    return decodeSegment(readFileSync(join(this.dir, name), 'utf8'), name);
  }

  /** Every record in the journal, oldest first. */
  readAll() {
    const records = [];
    for (const name of this.list()) records.push(...this.read(name).records);
    return records;
  }

  open() {
    mkdirSync(this.dir, { recursive: true });
    const names = this.list();
    if (names.length === 0) {
      this.current = 1;
      this.count = 0;
      this.log('journal', `new journal in ${this.dir}`);
      return;
    }
    const last = names[names.length - 1];
    const { records, torn } = this.read(last);
    if (torn) {
      writeFileSync(join(this.dir, last), records.map(encode).join(''));
      this.log('journal', `cut a torn last line off ${last}`);
    }
    this.current = segmentNumber(last);
    if (!Number.isInteger(this.current)) throw new JournalError(`cannot read the segment number of ${last}`);
    this.count = records.length;
    this.log('journal', `opened ${names.length} segments [${names.join(', ')}]; appending to ${last} (${this.count} records)`);
  }

  append(record) {
    if (this.current === 0) throw new JournalError('the journal is not open');
    if (this.count >= this.segmentSize) {
      this.current += 1;
      this.count = 0;
      this.log('journal', `rotated to ${segmentName(this.current)}`);
    }
    appendFileSync(join(this.dir, segmentName(this.current)), encode(record));
    this.count += 1;
  }
}
