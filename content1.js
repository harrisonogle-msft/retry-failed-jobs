(async function() {
    // alert('nice')
    // await new Promise(resolve => setTimeout(resolve, 1000));
    // alert('nice2')

    let res = await chrome.runtime.sendMessage({type: "ping", payload: {message: "PING"}});
    console.log("Received response from background script:");
    console.log(res);
})();

// chrome.runtime.sendMessage()