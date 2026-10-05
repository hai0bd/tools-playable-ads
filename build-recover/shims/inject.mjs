// esbuild inject: thay các biến toàn cục Buffer/process của Node trong mọi module của bundle
import { Buffer } from './buffer.js';
import process from './process.js';
export { Buffer, process };
