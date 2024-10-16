/**
 * Set the extension "action" button icon and title.
 * @param {whether the content script is running} running 
 * @param {the tab ID - if null, action for all tabs is updated} tabId 
 */
function setAction(tab, currentState) {

  let iconInputs = { tabId: tab.id };
  let titleInputs = { tabId: tab.id };

  let setIconPath = (icon) => {
    iconInputs.path = {
      16: `/icons/${icon}16x16.png`,
      32: `/icons/${icon}32x32.png`,
      48: `/icons/${icon}48x48.png`,
      128: `/icons/${icon}128x128.png`,
    };
  }
  let setTitle = (title) => titleInputs.title = title;

  let finalElapsed = getElapsedString(currentState.startTime, currentState.endTime);

  if (currentState.running) {
    setIconPath("blue");
    setTitle(`Periodically scanning for the rerun button. Click to cancel. (retries: ${currentState.retries})`);
  } else if (currentState.cancelled) {
    setIconPath("default");
    setTitle(`Automatic retry was cancelled. (reason: '${currentState.cancellationReason}', retries: ${currentState.retries}), elapsed: ${finalElapsed}`);
  } else if (currentState.finished && currentState.status === "success") {
    setIconPath("green");
    setTitle(`Pipeline succeeded. (retries: ${currentState.retries}, elapsed: ${finalElapsed})`);
  } else if (currentState.finished) {
    setIconPath("red");
    setTitle(`Pipeline failed or script timed out. (retries: ${currentState.retries}, elapsed: ${finalElapsed})`);
  } else {
    setIconPath("default");
    setTitle("Rerun failed jobs");
  }

  // Set the displayed icon.
  chrome.action.setIcon(iconInputs);

  // Set the displayed "title" (tooltip).
  chrome.action.setTitle(titleInputs);
}

function getElapsedString(startTimeMillis, endTimeMillis) {

  let seconds = (endTimeMillis - startTimeMillis) / 1000;
  let hours = Math.floor(seconds / 3600);
  seconds = seconds % 3600;
  let minutes = Math.floor(seconds / 60);
  seconds = Math.floor(seconds % 60);

  let hh = hours < 10 ? `0${hours}` : `${hours}`;
  let mm = minutes < 10 ? `0${minutes}` : `${minutes}`;
  let ss = seconds < 10 ? `0${seconds}` : `${seconds}`;

  return `${hh}:${mm}:${ss}`;
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
 * Signal the content script that the extension button ("action") was clicked.
 * @param {the tab where the content script is running} tab 
 * @returns 
 */
async function onActionClicked(tab) {

  console.log(`Notifying content script the user clicked the action button. (tabId: ${tab.id})`);

  let res = null;

  try {
    res = await chrome.tabs.sendMessage(
      tab.id,
      {
        type: "action-clicked",
        payload: { tabId: tab.id }
      }
    );
  } catch (e) {
    if (e.message === "Could not establish connection. Receiving end does not exist.") {
      res = await startContentScript(tab);
    }
  }

  console.log(`Received state update: ${JSON.stringify(res, null, 4)}`);
  return res;
}

/**
 * Start the content script (main loop) on the given tab.
 * @param {the current tab} tab 
 * @returns 
 */
async function startContentScript(tab) {

  let injectionResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content-scripts/content.js"]
  });

  console.log(injectionResults.length);
  let frameResult = injectionResults[0];
  let { frameId, result } = frameResult;
  console.log(`Frame ${frameId} result:`, result);

  return result;
}

/**
 * Handle a state update from the content script.
 * @param {the tab where the content script executes} tab 
 * @param {the current state of the content script} currentState 
 */
function handleStateUpdate(tab, currentState) {
  console.log(`Current state of content script: ${JSON.stringify(currentState, null, 4)}`);
  setAction(tab, currentState);
}

//
// Extension listeners
//

/**
 * React when the extension "action" button is clicked.
 */
chrome.action.onClicked.addListener(async (tab) => {

  console.log(`Action clicked.`);

  let currentState = null;

  try {
    currentState = await onActionClicked(tab);
  }
  catch (e) {
    console.log(`Error during state update request: ${e.message}`);
    throw e;
  }

  if (currentState != null) {
    handleStateUpdate(tab, currentState);
  }
});

/**
 * Receive messages from the content script.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  console.log(`Received message type '${message.type}'.`);
  console.log(message);

  switch (message.type)
  {
    case "ping":
      handlePing(message, sender, sendResponse);
      break;
    case "update-state":
      handleStateUpdate(sender.tab, message.payload);
      break;
    default:
      console.log(`Unable to parse message of type '${(message.type == null ? "(null or undefined)" : message.type)}'`);
      break;
  }

  function handlePing(message, sender, sendResponse) {
    sendResponse({
      tabId: sender.tab.id,
      payload: {
        originalMessage: message
      }
    });
  }
});

/**
 * 
 * @param {*} tabId 
 * @param {*} changeInfo 
 * @param {*} tabInfo 
 */
function handleUpdated(tabId, changeInfo, tabInfo) {
}

/**
 * Let the content script know the user navigated away so it can cancel polling and retry.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tabInfo) => {
  if (changeInfo.url) {
    console.log(`Tab: ${tabId} URL changed.`);;
    await chrome.tabs.sendMessage(
      tabId,
      {
        type: "url-updated",
        payload: { tabId, url: changeInfo.url }
      }
    );
  }
});