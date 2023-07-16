// let state = null;

// const sendMessageId = document.getElementById("sendmessageid");

// if (sendMessageId) {

//   sendMessageId.onclick = async function() {

//     chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {

//       let res = await chrome.tabs.sendMessage(
//         tabs[0].id,
//         {
//           type: 'start-retry-script',
//           tabId: tabs[0].id
//         },
//       );

//       await chrome.tabs.sendMessage(
//         tabs[0].id,
//         {
//           type: 'ack',
//           payload: res,
//           tabId: tabs[0].id
//         },
//       );

//     });

//   };
// }


// chrome.runtime.onConnect.addListener(port => {
//   port.onMessage.addListener(msg => {
//     // Handle message however you want
//   });
// });

// "content-scripts/content.js"

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => sendResponse('pong'));

// chrome.action.onClicked.addListener(async (tab) => {

//       let res = await chrome.tabs.sendMessage(
//         tab.id,
//         {
//           type: 'start-retry-script',
//           tabId: tab.id
//         },
//       );

//       await chrome.tabs.sendMessage(
//         tabs[0].id,
//         {
//           type: 'ack',
//           payload: res,
//           tabId: tabs[0].id
//         },
//       );
// });

let red = false;

chrome.action.onClicked.addListener(async (tab) => {
  // chrome.scripting.executeScript({
  //   target: {tabId: tab.id},
  //   // files: ["content-scripts/content.js"]
  //   files: ["content1.js"]
  // });

  // let pathToIcon = red ? "icons/gray16x16.png" : "icons/red16x16.png";
  red = !red;
  // chrome.action.setIcon({path: pathToIcon, tabId: tab.id});
  try {
    chrome.action.setIcon({
      imageData: {
        16: "icons/gray16x16.png"
      },
    });
      // tabId: tab.id
  } catch (e) {
    console.log(e);
  }

  // chrome.tabs.query({active:true, windowType:"normal", currentWindow: true},function(d){
  //       var tabId = d[0].id;
  //       chrome.browserAction.setIcon({path: pathToIcon, tabId: tabId});
  //   });
});