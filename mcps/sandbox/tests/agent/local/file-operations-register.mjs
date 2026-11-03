import { isInternalThread } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

if (!isInternalThread) register();
