// Sample module for outline tests.
import { readFileSync } from 'node:fs';

export function load(path) {
  return readFileSync(path, 'utf8');
}

async function* walk(root) {
  yield root;
}

export const parse = (text, options = {}) => {
  return text.split('\n');
};

const render = async function (items) {
  return items.join(',');
};

export default class Store extends Base {
  constructor(name) {
    super();
    this.name = name;
    if (name) {
      this.ready = true;
    }
  }

  static create(name) {
    return new Store(name);
  }

  async save(data) {
    for (const item of data) {
      console.log(item);
    }
  }

  get size() {
    return 1;
  }
}

function tail() {
  return 0;
}
