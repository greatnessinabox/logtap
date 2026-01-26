/**
 * LogTap 3.0 - Snapshot Engine
 * Deep cloning with circular reference handling and special type preservation
 */

const CONFIG = {
  maxDepth: 10,
  maxStringLength: 5000,
  maxArrayLength: 500,
  maxObjectKeys: 50,
  maxTotalSize: 512 * 1024 // 512KB
};

const TYPE_MARKERS = {
  DATE: '__$date',
  REGEXP: '__$regexp',
  ERROR: '__$error',
  MAP: '__$map',
  SET: '__$set',
  SYMBOL: '__$symbol',
  FUNCTION: '__$function',
  UNDEFINED: '__$undefined',
  BIGINT: '__$bigint',
  CIRCULAR: '__$circular',
  MAX_DEPTH: '__$maxDepth',
  DOM_ELEMENT: '__$element',
  TYPED_ARRAY: '__$typedArray'
};

function isPlainObject(obj) {
  if (typeof obj !== 'object' || obj === null) return false;
  const proto = Object.getPrototypeOf(obj);
  return proto === null || proto === Object.prototype;
}

function isDOMElement(val) {
  return typeof Element !== 'undefined' && val instanceof Element;
}

function isTypedArray(val) {
  return ArrayBuffer.isView(val) && !(val instanceof DataView);
}

/**
 * Deep snapshot of a value
 */
export function deepSnapshot(value, maxDepth = CONFIG.maxDepth, seen = new WeakMap(), path = 'root') {
  // Primitives
  if (value === null) return null;
  if (value === undefined) return { [TYPE_MARKERS.UNDEFINED]: true };

  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return { [TYPE_MARKERS.UNDEFINED]: Number.isNaN(value) ? 'NaN' : (value > 0 ? 'Infinity' : '-Infinity') };
    }
    return value;
  }

  if (typeof value === 'bigint') return { [TYPE_MARKERS.BIGINT]: value.toString() };
  if (typeof value === 'symbol') return { [TYPE_MARKERS.SYMBOL]: value.toString() };

  if (typeof value === 'string') {
    return value.length > CONFIG.maxStringLength
      ? value.slice(0, CONFIG.maxStringLength) + `... [${value.length - CONFIG.maxStringLength} more]`
      : value;
  }

  if (typeof value === 'function') {
    return { [TYPE_MARKERS.FUNCTION]: value.name || 'anonymous' };
  }

  // Depth limit
  if (maxDepth <= 0) return { [TYPE_MARKERS.MAX_DEPTH]: true };

  // DOM Elements
  if (isDOMElement(value)) {
    return {
      [TYPE_MARKERS.DOM_ELEMENT]: value.tagName.toLowerCase(),
      id: value.id || undefined,
      className: value.className || undefined
    };
  }

  // Circular reference check
  if (typeof value === 'object' && seen.has(value)) {
    return { [TYPE_MARKERS.CIRCULAR]: seen.get(value) };
  }
  if (typeof value === 'object') {
    seen.set(value, path);
  }

  // Special types
  if (value instanceof Date) {
    return { [TYPE_MARKERS.DATE]: value.toISOString() };
  }

  if (value instanceof RegExp) {
    return { [TYPE_MARKERS.REGEXP]: value.toString() };
  }

  if (value instanceof Error) {
    return {
      [TYPE_MARKERS.ERROR]: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (value instanceof Map) {
    const entries = [];
    let i = 0;
    for (const [k, v] of value) {
      if (i >= CONFIG.maxArrayLength) break;
      entries.push([
        deepSnapshot(k, maxDepth - 1, seen, `${path}.key${i}`),
        deepSnapshot(v, maxDepth - 1, seen, `${path}.val${i}`)
      ]);
      i++;
    }
    return { [TYPE_MARKERS.MAP]: entries, size: value.size };
  }

  if (value instanceof Set) {
    const values = [];
    let i = 0;
    for (const v of value) {
      if (i >= CONFIG.maxArrayLength) break;
      values.push(deepSnapshot(v, maxDepth - 1, seen, `${path}[${i}]`));
      i++;
    }
    return { [TYPE_MARKERS.SET]: values, size: value.size };
  }

  if (isTypedArray(value)) {
    return {
      [TYPE_MARKERS.TYPED_ARRAY]: value.constructor.name,
      data: Array.from(value.slice(0, CONFIG.maxArrayLength)),
      length: value.length
    };
  }

  // Arrays
  if (Array.isArray(value)) {
    const arr = [];
    const len = Math.min(value.length, CONFIG.maxArrayLength);
    for (let i = 0; i < len; i++) {
      arr.push(deepSnapshot(value[i], maxDepth - 1, seen, `${path}[${i}]`));
    }
    if (value.length > len) {
      arr.push(`... ${value.length - len} more items`);
    }
    return arr;
  }

  // Objects
  if (typeof value === 'object') {
    const obj = {};
    const keys = Object.keys(value);
    const len = Math.min(keys.length, CONFIG.maxObjectKeys);

    for (let i = 0; i < len; i++) {
      const key = keys[i];
      try {
        obj[key] = deepSnapshot(value[key], maxDepth - 1, seen, `${path}.${key}`);
      } catch {
        obj[key] = '[Error accessing property]';
      }
    }

    if (keys.length > len) {
      obj['...'] = `${keys.length - len} more properties`;
    }

    if (!isPlainObject(value) && value.constructor?.name) {
      obj.__$type = value.constructor.name;
    }

    return obj;
  }

  return String(value);
}

/**
 * Serialize console.log arguments
 */
export function serializeArgs(args) {
  if (!args?.length) return { message: '', snapshot: null };

  const snapshots = args.map(arg => {
    try {
      return deepSnapshot(arg);
    } catch {
      return '[Snapshot Error]';
    }
  });

  const messageParts = args.map((arg, i) => {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    if (arg instanceof Error) return arg.message || String(arg);
    if (isDOMElement(arg)) return `<${arg.tagName.toLowerCase()}>`;

    try {
      const str = JSON.stringify(snapshots[i]);
      return str.length > 200 ? JSON.stringify(snapshots[i], null, 2) : str;
    } catch {
      return Object.prototype.toString.call(arg);
    }
  });

  return {
    message: messageParts.join(' '),
    snapshot: snapshots.length === 1 ? snapshots[0] : snapshots
  };
}

/**
 * Format a snapshot for display
 */
export function formatSnapshot(snapshot) {
  if (snapshot === null) return 'null';
  if (typeof snapshot !== 'object') return String(snapshot);

  if (snapshot[TYPE_MARKERS.DATE]) return `Date(${snapshot[TYPE_MARKERS.DATE]})`;
  if (snapshot[TYPE_MARKERS.REGEXP]) return snapshot[TYPE_MARKERS.REGEXP];
  if (snapshot[TYPE_MARKERS.ERROR]) return `${snapshot[TYPE_MARKERS.ERROR]}: ${snapshot.message}`;
  if (snapshot[TYPE_MARKERS.CIRCULAR]) return `[Circular: ${snapshot[TYPE_MARKERS.CIRCULAR]}]`;
  if (snapshot[TYPE_MARKERS.MAX_DEPTH]) return '[Max Depth]';
  if (snapshot[TYPE_MARKERS.FUNCTION]) return `[Function: ${snapshot[TYPE_MARKERS.FUNCTION]}]`;
  if (snapshot[TYPE_MARKERS.SYMBOL]) return snapshot[TYPE_MARKERS.SYMBOL];
  if (snapshot[TYPE_MARKERS.UNDEFINED]) return snapshot[TYPE_MARKERS.UNDEFINED] === true ? 'undefined' : snapshot[TYPE_MARKERS.UNDEFINED];
  if (snapshot[TYPE_MARKERS.BIGINT]) return `${snapshot[TYPE_MARKERS.BIGINT]}n`;

  if (snapshot[TYPE_MARKERS.DOM_ELEMENT]) {
    const id = snapshot.id ? `#${snapshot.id}` : '';
    const cls = snapshot.className ? `.${snapshot.className.split(' ').join('.')}` : '';
    return `<${snapshot[TYPE_MARKERS.DOM_ELEMENT]}${id}${cls}>`;
  }

  try {
    return JSON.stringify(snapshot, null, 2);
  } catch {
    return '[Complex Object]';
  }
}

export { TYPE_MARKERS, CONFIG };
