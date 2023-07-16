async function main() {

  logger.log(`Starting extension. (extension id: ${chrome.runtime.id})`);
  alert('nice!')

  const loop = new Loop();
  let initialized = false;

  /**
   * Listen to messages from the background script (thing which handles events from the extension button).
   */
  chrome.runtime.onMessage.addListener(async function (payload) {

    console.log(`Received message from background script: ${JSON.stringify(payload, null, 4)}`);
    // console.log(payload); // logging separately for debugger interactivity

    if (!loop.running) {
      logger.log("Starting the main loop.");
      loop.start();
    }

    if (!initialized) {
      logger.log('initializing')
      initialized = true;
      let res = await chrome.runtime.sendMessage(chrome.runtime.id, {ping: "please"});
      logger.log(res);
    }

    return loop.currentState;
    // sendResponse(loop.currentState);
  });
}

class Loop {

  static #LOOP_ITER_DELAY_MILLIS = 2 * 1000;
  static #TIMEOUT_MILLIS = 5 * 60 * 60 * 1000;
  static #MAX_RETRY_COUNT = 5;
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
      startTime: this.#startTime,
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
    }, TIMEOUT_MILLIS);

    while (this.#shouldRun) {

      logger.log(`Scanning for the retry button.`);

      if (this.#findButtonAndClick(Loop.#retryButtonText)) {

        // Wait for a second before checking for the confirmation modal.
        // Could replace with something like [webdriver waits](https://www.selenium.dev/documentation/webdriver/waits/)
        // but the 1 second static delay really doesn't matter here.
        await Task.Delay(1000);

        if (this.#findButtonAndClick(Loop.#confirmButtonText)) {
          this.#retries++;
          logger.log(`Executing retry number ${this.#retries}...`);
        }
      }

      if (this.#shouldRun) {
        logger.log(`Sleeping for ${LOOP_ITER_DELAY_MILLIS}ms...`);
        await Task.Delay(LOOP_ITER_DELAY_MILLIS);
      }

      // Send a current state update to the background script.
      this.#sendUpdate();
    }

    this.#endTime = new Date();
    logger.log(`Exiting main loop (retries: ${this.#retries}, elapsed: ${(this.elapsedMillis/1000.0).toFixed(2)}s)`);
    logger.log(this);

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
    return !this.#canceled && this.#retries < MAX_RETRY_COUNT;
  }

  /**
   * Whether the main loop is currently running.
   */
  get running() {
    return this.#startTime != null && this.#endTime == null;
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
   * Find a button on the page by its child span's text content and click it.
   * If multiple such buttons are found, only the first will be clicked.
   * @param {The text content} textContent 
   */
  #findButtonAndClick(textContent) {

    // Debugging
    alert(`#findButtonAndClick(${textContent})`);
    return true;

    // If there are multiple buttons, only the first will be clicked.
    let clicked = false;

    document.querySelectorAll('button > span').forEach(el => {
      if (!clicked && el.textContent.includes(textContent)) {
        clicked = true;
        logger.log(`Clicking button: ${el}`);
        el.click();
      }
    });

    return clicked;
  }

}

/**
 * Bind to the console so that logs can be prefixed with extension name and timestamp.
 */
var logger = (function() {

    var timestamp = function() { };

    timestamp.toString = function() {
        return "[retry-failed-jobs " + (new Date).toLocaleTimeString() + "]";    
    };

    return {
      log: console.log.bind(console, '%s', timestamp),
      error: console.error.bind(console, '%s', timestamp),
      info: console.info.bind(console, '%s', timestamp),
      warn: console.warn.bind(console, '%s', timestamp),
    };

})();

class Task
{
  static async Delay(millis) {
    await new Promise(resolve => setTimeout(resolve, millis));
  }
}

(async function() {
  await main();
})();