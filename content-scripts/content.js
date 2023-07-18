class JobStatus {
  static SUCCESS = "success";
  static FAILED = "failed";
  static ACTIVE = "active";
  static UNKNOWN = "unknown";
}

async function main() {

  logger.log(`Extension started. (extension id: ${chrome.runtime.id})`);

  const loop = new RerunManager();

  /**
   * Listen to messages from the background script (thing which handles events from the extension button).
   */
  chrome.runtime.onMessage.addListener(async function (message) {

    switch (message.type) {
      case "action-clicked":
        if (loop.running) {
          logger.log("Extension action button was clicked. Cancelling...");
          loop.cancel("cancelled by user");
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

  // Since we're web scraping, do a dry run to make sure the elements are still detectable.
  // These warnings will appear if/when the HTML/CSS of the page is changed in a breaking manner.
  let detectedJobStatus = loop.jobStatus;
  if (detectedJobStatus === JobStatus.UNKNOWN) {

    logger.warn(`Unable to detect the ADO pipeline job status based on the existing CSS selector ` +
      `'${RerunManager.STATUS_ICON_SELECTOR}' and icon class list '[${RerunManager.STATUS_ICON_CLASSES}]'. ` +
      `HTML/CSS detection may be broken.`);

  } else if (detectedJobStatus === JobStatus.FAILED && !loop.detectButton(RerunManager.RETRY_BUTTON_TEXT)) {

    logger.warn(`Unable to detect the retry button based on the text content '${RerunManager.RETRY_BUTTON_TEXT}'` +
      `and the existing CSS selector '${RerunManager.BUTTON_SELECTOR}' despite the pipeline being in failure state. ` +
      `HTML/CSS detection may be broken.`);

  }

  if (!loop.running) {
    logger.log("Extension action button was clicked. Starting...");
    loop.start();
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

  // Behavioral constants
  static MAX_RETRY_COUNT = 8; // retry the failed jobs at most 8 times
  static ITER_DELAY_MILLIS = 60 * 1000; // check for the retry button every minute
  static TIMEOUT_MILLIS = 5 * 60 * 60 * 1000; // time out after 5 hours

  // Web scraping element detection constants
  static RETRY_BUTTON_TEXT = "Rerun failed jobs";
  static CONFIRM_BUTTON_TEXT = "Yes";
  static BUTTON_SELECTOR = "button > span";
  static STATUS_ICON_SELECTOR = "svg.bolt-status";
  static STATUS_ICON_CLASSES = [JobStatus.SUCCESS, JobStatus.FAILED, JobStatus.ACTIVE, "animate"];

  // Private instance members
  #startTime = null;
  #endTime = null;
  #retries = 0;
  #cancelled = false;
  #cancellationReason = null;
  #cancellationNonce = null;

  constructor() {
  }

  /**
   * Convert the current state to a serializable object to send to the background script.
   * @returns The current state of the main loop.
   */
  get currentState() {
    return {
      running: this.running,
      cancelled: this.#cancelled,
      finished: this.finished,
      status: this.jobStatus,
      startTime: (this.#startTime == null ? 0 : this.#startTime.getTime()), // timestamp with milliseconds precision
      endTime: (this.#endTime == null ? 0 : this.#endTime.getTime()), // timestamp with milliseconds precision
      retries: this.#retries,
      cancellationReason: this.#cancellationReason
    };
  }

  resetState() {
    this.#startTime = null;
    this.#endTime = null;
    this.#retries = 0;
    this.#cancelled = false;
    this.#cancellationReason = null;
    this.#cancellationNonce = null;
  }

  /**
   * Start a new retry loop.
  */
  async start() {

    this.resetState();
    this.#startTime = new Date();
    let nonce = uuidv4();
    this.#cancellationNonce = nonce;

    // Automatically stop probing for the button after the timeout expires.
    setTimeout(() => {
      if (!this.#cancelled && this.#cancellationNonce === nonce) {
        logger.log(`Timeout reached. Cancelling...`);
        this.cancel("timed out");
      }
    }, RerunManager.TIMEOUT_MILLIS);

    // Send a current state update to the background script.
    this.#sendUpdate();

    while (this.#shouldRun) {

      let clicked = false;

      if (this.#clickButton(RerunManager.RETRY_BUTTON_TEXT)) {

        // Wait for a second before checking for the confirmation modal.
        // Could replace with something like [webdriver waits](https://www.selenium.dev/documentation/webdriver/waits/)
        // but the 1 second static delay really doesn't matter here.
        await Task.Delay(1000);

        if (this.#clickButton(RerunManager.CONFIRM_BUTTON_TEXT)) {
          this.#retries++;
          clicked = true;
          logger.log(`Executing retry. (${this.#retries}/${RerunManager.MAX_RETRY_COUNT})`);
          this.#sendUpdate();
        } else {
          logger.warn("Clicked retry button, but was unable to click the confirm button.");
        }
      } else {
        let status = this.jobStatus; // pin it
        if (status !== JobStatus.SUCCESS && status !== JobStatus.ACTIVE) {
          // If pipeline status is "failed", the button is supposed to be present.
          // This warning will appear if/when the HTML/CSS for the button changes
          // enough to break the button detection.
          logger.warn("Unable to detect and click the retry button.");
        }
      }

      // Wait for the ADO job status to be active.
      // It takes quite a few seconds for ADO to submit the job and update the page.
      if (clicked) {
        let waitForPageToRespondTimeout = 30 * 1000;
        let timeout = new Date().getTime() + waitForPageToRespondTimeout;
        if (!this.#cancelled && this.jobStatus !== JobStatus.ACTIVE && new Date().getTime() < timeout) {
          logger.log("Button was clicked; waiting for ADO to update the job status...");
          do {
            await Task.Delay(1000);
          } while (!this.#cancelled && this.jobStatus !== JobStatus.ACTIVE && new Date().getTime() < timeout);
          if (this.jobStatus === JobStatus.ACTIVE) {
            logger.log("ADO job started.");
          }
        }
      }

      // Sleep for the iteration delay, supporting cancellation (no CancellationTokens in JS).
      let sleepStart = new Date().getTime();
      while (this.#shouldRun && (new Date().getTime() - sleepStart) < RerunManager.ITER_DELAY_MILLIS) {
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
    if (!this.#cancelled && this.jobStatus === JobStatus.ACTIVE) {
      logger.info("Last retry attempt submitted. Waiting for the ADO job to finish...");
      do {
        await Task.Delay(1000);
      } while (!this.#cancelled && this.jobStatus === JobStatus.ACTIVE);
    }

    if (!this.#cancelled) {
      this.#endTime = new Date();
    }
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
  cancel(reason) {
    this.#endTime = new Date();
    this.#cancelled = true;
    this.#cancellationReason = reason;
    this.#sendUpdate();
  }

  /**
   * Whether or not the main loop should continue.
   */
  get #shouldRun() {
    return !this.#cancelled && this.#retries < RerunManager.MAX_RETRY_COUNT;
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
    return this.#endTime != null && !this.#cancelled;
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

    let status = JobStatus.UNKNOWN;

    // Get the first pipeline status icon on the page.
    let icon = document.querySelector(RerunManager.STATUS_ICON_SELECTOR);

    if (icon != null && icon.classList != null) {

      // Detect status using the icon's class list.
      for (const clsName of RerunManager.STATUS_ICON_CLASSES) {
        if (icon.classList.contains(clsName)) {
          status = clsName;
          break;
        }
      }

      // Remap "animate" to "active" because they both indicate the same state (one is spinny, though).
      if (status === "animate") {
        status = JobStatus.ACTIVE;
      }

    }

    return status;
  }

  #clickButton(textContent) {
    return this.detectButton(textContent, btn => btn.click());
  }

  /**
   * Detect a button on the page by its child span's text content and perform the given action on it.
   * If multiple such buttons are found, only the first will be clicked.
   * @param {The text content to match} textContent 
   * @param {Action to perform on the found button} textContent 
   */
  detectButton(textContent, action = btn => { }) {

    // If there are multiple buttons, only the first will be considered.
    let button = null;

    document.querySelectorAll(RerunManager.BUTTON_SELECTOR).forEach(el => {
      if (!button && el.textContent.includes(textContent)) {
        button = el;
      }
    });

    let found = button !== null;

    if (found) {
      action(button);
    }

    return found;

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

/**
 * Helper function to generate a guid.
 * @returns a guid
 */
function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

// This top-level expression is returned as a frame result
// to the caller of `chrome.scripting.executeScript`, if applicable.
(async function () {
  return await main();
})();