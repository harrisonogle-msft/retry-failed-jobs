class JobStatus {
  static SUCCESS = "success";
  static FAILED = "failed";
  static ACTIVE = "active";
  static UNKNOWN = "unknown";
}

async function main() {

  logger.log(`Starting extension. (extension id: ${chrome.runtime.id})`);

  const loop = new RerunManager();
  let initialized = false;

  /**
   * Listen to messages from the background script (thing which handles events from the extension button).
   */
  chrome.runtime.onMessage.addListener(async function (message) {

    console.log(`Received message from background script: ${JSON.stringify(message, null, 4)}`);

    switch (message.type) {
      case "action-clicked":
        if (loop.running) {
          logger.log("Extension action button was clicked. Cancelling...");
          loop.cancel();
        } else {
          logger.log("Extension action button was clicked. Starting...");
          loop.start();
        }
        break;
      default:
        console.log(`Unable to parse message of type '${(message.type == null ? "(null or undefined)" : message.type)}'`);
        break;
    }

  });

  if (!loop.running) {
    loop.start();
  }

  // Sanity check.
  if (!initialized) {
    logger.log('Sending sanity check ping to background script.')
    initialized = true;
    let res = await chrome.runtime.sendMessage(chrome.runtime.id, { type: "ping", payload: "Content script started." });
    logger.log(res);
  }

  return loop.currentState;
}

/**
 * Get the current tab. Requires "tabs" manifest permission.
 * @returns the current tab
 */
async function getCurrentTab() {
  let queryOptions = { active: true, lastFocusedWindow: true };
  let [tab] = await chrome.tabs.query(queryOptions);
  return tab;
}

/**
 * Manager class responsible for the following:
 * - detection of the ADO pipeline status (active/failed/success)
 * - detection and click of the "rerun failed jobs" button
 * - communication of state with the background script
 * - lifetime of the running content script (timeout/cancel/retries)
 */
class RerunManager {

  static #ITER_DELAY_MILLIS = 60 * 1000;
  static #TIMEOUT_MILLIS = 5 * 60 * 60 * 1000;
  static #MAX_RETRY_COUNT = 3;
  static #retryButtonText = "Rerun failed jobs";
  static #confirmButtonText = "Yes";

  #canceled = false;
  #retries = 0;
  #startTime = null;
  #endTime = null;

  constructor() {
  }

  /**
   * Convert the current state to a serializable object to send to the background script.
   * @returns The current state of the main loop.
   */
  get currentState() {
    return {
      running: this.running,
      canceled: this.#canceled,
      finished: this.finished,
      status: this.jobStatus,
      startTime: (this.#startTime == null ? 0 : this.#startTime.getTime()), // timestamp with milliseconds precision
      endTime: (this.#endTime == null ? 0 : this.#endTime.getTime()), // timestamp with milliseconds precision
      retries: this.#retries,
      elapsedMillis: this.elapsedMillis,
    };
  }

  #reset() {
    this.#canceled = false;
    this.#retries = 0;
    this.#startTime = null;
    this.#endTime = null;
  }

  /**
   * Start a new retry loop.
  */
  async start() {

    logger.log("Starting main loop.");

    this.#reset();
    this.#startTime = new Date();

    // Automatically stop probing for the button after the timeout expires.
    setTimeout(() => {
      logger.log(`Timeout reached. Cancelling...`);
      this.#canceled = true;
      this.#sendUpdate();
    }, RerunManager.#TIMEOUT_MILLIS);

    // Send a current state update to the background script.
    this.#sendUpdate();

    while (this.#shouldRun) {

      if (this.#findButtonAndClick(RerunManager.#retryButtonText)) {

        // Wait for a second before checking for the confirmation modal.
        // Could replace with something like [webdriver waits](https://www.selenium.dev/documentation/webdriver/waits/)
        // but the 1 second static delay really doesn't matter here.
        await Task.Delay(1000);

        if (this.#findButtonAndClick(RerunManager.#confirmButtonText)) {
          this.#retries++;
          logger.log(`Executing retry number ${this.#retries}...`);
        } else {
          logger.warn("Clicked retry button, but was unable to click the confirm button.");
        }
      } else {
        let status = this.jobStatus;
        if (status !== JobStatus.SUCCESS && status !== JobStatus.ACTIVE) {
          // If pipeline status is "failed", the button is supposed to be present.
          // This warning will appear if/when the HTML/CSS for the button changes
          // enough to break the button detection.
          logger.warn("Unable to detect and click the retry button.");
        }
      }

      // No CancellationTokens in JS
      let sleepStart = new Date().getTime();
      while (this.#shouldRun && (new Date().getTime() - sleepStart) < RerunManager.#ITER_DELAY_MILLIS) {
        await Task.Delay(1000);
      }

      // If we detected the pipeline finished, stop the script.
      // This check requires that the iteration delay is long enough for ADO to
      // update the page after the failed jobs are rerun, which sometimes takes >10s.
      if (this.jobStatus === JobStatus.SUCCESS) {
        logger.log(`Detected that the pipeline completed successfully.`);
        break;
      }
    }

    // The last retry attempt was submitted, but the pipeline is
    // still running, so wait for it to finish before exiting.
    while (!this.#canceled && this.jobStatus === JobStatus.ACTIVE) {
      await Task.Delay(1000);
    }

    this.#endTime = new Date();
    logger.log(`Exiting main loop (retries: ${this.#retries}, elapsed: ${(this.elapsedMillis / 1000.0).toFixed(2)}s)`);
    logger.log(this);

    // Send a current state update to the background script.
    this.#sendUpdate();

  }

  /**
   * Send a state update to the background script so it can update the extension popup visuals.
   */
  #sendUpdate() {
    chrome.runtime.sendMessage({ type: "update-state", payload: this.currentState });
  }

  /**
   * Cancel the current execution. Allows for graceful shutdown.
   */
  cancel() {
    this.#canceled = true;
  }

  /**
   * Whether or not the main loop should continue.
   */
  get #shouldRun() {
    return !this.#canceled && this.#retries < RerunManager.#MAX_RETRY_COUNT;
  }

  /**
   * Whether the main loop is currently running.
   */
  get running() {
    return this.#startTime != null && this.#endTime == null;
  }

  /**
   * Whether the main loop has finished on its own (without being user-cancelled).
   */
  get finished() {
    return this.#endTime != null;
  }

  /**
   * Gets the elapsed time in milliseconds since the main loop started.
   */
  get elapsedMillis() {
    if (this.#startTime != null && this.#endTime != null) {
      return this.#endTime - this.#startTime;
    } else if (this.#startTime != null) {
      return new Date() - this.#startTime;
    } else {
      return -1;
    }
  }

  /**
   * Detect the ADO pipeline status by checking for the status icon.
   */
  get jobStatus() {

    let cssSelector = "svg.bolt-status";
    let iconClasses = [JobStatus.SUCCESS, JobStatus.FAILED, JobStatus.ACTIVE, "animate"];
;
    let detected = JobStatus.UNKNOWN;

    // Get the first pipeline status icon on the page.
    let icon = document.querySelector(cssSelector);

    if (icon != null && icon.classList != null) {

      // Detect status using the icon's class list.
      for (const clsName of iconClasses) {
        if (icon.classList.contains(clsName)) {
          // return clsName;
          detected = clsName;
        }
      }

      // Remap "animate" to "active" because they both indicate the same state (one is spinny, though).
      if (detected === "animate") {
        detected = JobStatus.ACTIVE;
      }

    }

    if (detected === JobStatus.UNKNOWN) {
      // This warning will appear if/when the HTML/CSS of the page is changed in a breaking manner.
      logger.warn(`Unable to detect the ADO pipeline job status based on the existing CSS selector '${cssSelector}' and icon class list '${iconClasses}'`);
    }

    return detected;
  }

  /**
   * Find a button on the page by its child span's text content and click it.
   * If multiple such buttons are found, only the first will be clicked.
   * @param {The text content} textContent 
   */
  #findButtonAndClick(textContent) {

    // If there are multiple buttons, only the first will be clicked.
    let clicked = false;

    document.querySelectorAll('button > span').forEach(el => {
      if (!clicked && el.textContent.includes(textContent)) {
        clicked = true;
        el.click();
      }
    });

    return clicked;
  }

}

/**
 * Bind to the console so that logs can be prefixed with extension name and timestamp.
 */
var logger = (function () {

  var timestamp = function () { };

  timestamp.toString = function () {
    return "[retry-failed-jobs " + (new Date).toLocaleTimeString() + "]";
  };

  return {
    log: console.log.bind(console, '%s', timestamp),
    error: console.error.bind(console, '%s', timestamp),
    info: console.info.bind(console, '%s', timestamp),
    warn: console.warn.bind(console, '%s', timestamp),
  };

})();

class Task {
  static async Delay(millis) {
    await new Promise(resolve => setTimeout(resolve, millis));
  }
}

// This top-level expression is returned as a frame result
// to the caller of `chrome.scripting.executeScript`, if applicable.
(async function () {
  return await main();
})();