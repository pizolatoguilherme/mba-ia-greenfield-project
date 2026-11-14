/** Queue that receives one job per completed upload (TD-02, TD-05). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const PROCESS_VIDEO_JOB = 'process-video';

export interface ProcessVideoJobData {
  videoId: string;
}

/** Retry policy for `process-video` (TD-06): 3 tries, exponential from 30 s. */
export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30000 },
} as const;
