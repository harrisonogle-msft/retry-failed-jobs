## How to add the extension to Edge

0. Open Edge.
1. Navigate to edge://extensions
2. Click "Load unpacked"
3. Navigate to the repo root directory (the one containing this file) and click "Select Folder".

The extension will now be appear in the extensions submenu in the top right of your browser. In the current release of Edge, the icon is a puzzle piece.

> Recommended: In the submenu, to the right of the extension name, click the eyeball ("Show in toolbar").

## How to use the extension

0. Navigate to a failed build.
    - This includes any ADO page with a "Rerun failed jobs" button. So all build pipelines.
1. Click the extension icon.

The script will automatically check the state of the ADO job. If it's in a failed state, the script will automatically rerun the job by clicking the "Rerun failed jobs" button. The script checks the state of the ADO job every minute and retries up to 5 times.

To increase or configure the number of retries, add the query parameter `maxRetryCount=n` to the URL and refresh the page before activating the extension (replace `n` with desired number of retries).
