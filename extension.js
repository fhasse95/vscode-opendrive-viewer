const vscode = require('vscode');
const odrviewer = require("./odrviewer");
const { RuntimeManager } = require("./odrviewer/runtime");
const path = require('path');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	const runtimeManager = new RuntimeManager(context);
	const runtimeCommand = 'opendrive-viewer.downloadRuntime';

	async function downloadRuntime() {
		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Downloading ODRViewer runtime",
				cancellable: false
			}, () => runtimeManager.download());
			vscode.window.showInformationMessage("ODRViewer runtime is ready.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`ODRViewer runtime download failed: ${message}`);
		}
	}

	async function checkRuntime() {
		try {
			const result = await runtimeManager.checkForUpdate();
			if (result.status === "missing") {
				const choice = await vscode.window.showInformationMessage(
					"ODRViewer runtime is not installed.",
					"Download ODRViewer Runtime"
				);
				if (choice === "Download ODRViewer Runtime") { await downloadRuntime(); }
			} else if (result.status === "update") {
				const choice = await vscode.window.showInformationMessage(
					"A newer ODRViewer runtime is available.",
					"Update ODRViewer Runtime"
				);
				if (choice === "Update ODRViewer Runtime") { await downloadRuntime(); }
			}
		} catch {
			// Runtime checks are best effort when the website is unavailable.
		}
	}

	const runtimeDisposable = vscode.commands.registerCommand(runtimeCommand, checkRuntime);
	context.subscriptions.push(runtimeDisposable);

	/**
	 * Notification utility class to handle promises of progress from the 
	 * WebView side. The progress is marked with a "unique identification"
	 * string. When the notification is complete, the id is marked as to be resolved.
	 * The notification id is a serializable value that can be shared with the 
	 * WebView component.
	 */
	class Notifications {
		constructor() {
			this.notifications = {};
		}
		/**
		 * Utility to create a new unique notification id. Collisions are
		 * checked.
		 * 
		 * @return {String} a notification identifier string
		 */
		createNotificationId() {
			while (true) {
				const nid = "nid" + Math.random().toString(16).slice(2);
				if (!this.notifications[nid]) {
					return nid;
				}
			}
		}
		/**
		 * Starts a notification with progress. Notification is marked with
		 * a notification Id and can be used to resolve its execution. Progress
		 * are not meant to be cancellable, as for now.
		 * 
		 * @param {String} notificationId the notification identifier to be used
		 * @param {String} message the message to include in the notification
		 */
		notifyProgress(notificationId, message) {
			const notification = { resolve: null };
			this.notifications[notificationId] = notification;

			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: message,
				cancellable: false
			}, () => {
				return new Promise(resolve => {
					notification.resolve = () => {
						resolve();
						delete this.notifications[notificationId];
					};
				});
			});
		}
		/**
		 * Resolve an existing notification
		 * 
		 * @param {String} notificationId the notification to be resolved
		 */
		resolveProgress(notificationId) {
			this.notifications[notificationId]?.resolve?.();
		}
		/**
		 * Create a notification for errors
		 * 
		 * @param {String} message Error message
		 */
		notifyError(message) {
			vscode.window.showErrorMessage(message);
		}
	};

	/**
	 * Main application function. The applications more or less does the following.
	 * 
	 *  1. Create a webview in which OdrViewer HTML code is injected, and is attached to the
	 *     current active editor (originalEditor)
	 *  2. The extension attaches to onSave event of the workspace. The event will update the
	 *     map contained in viewer with the updated version
	 *  3. The webview, once is completely loaded, send a "load" command to extension
	 *  4. extension replies with a "payload" command to load the first map
	 */
	function openDriveViewerShow() {
		if (!runtimeManager.isInstalled()) {
			void vscode.window.showInformationMessage(
				"ODRViewer runtime is not installed.",
				"Download ODRViewer Runtime"
			).then(choice => {
				if (choice === "Download ODRViewer Runtime") { return downloadRuntime(); }
				return undefined;
			}).catch(error => {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`ODRViewer runtime setup failed: ${message}`);
			});
			return;
		}

		const originalEditor = vscode.window.activeTextEditor;
		if (!originalEditor || originalEditor.document.languageId !== 'OpenDRIVE') {
			vscode.window.showErrorMessage("OpenDRIVE Viewer requires an active .xodr editor.");
			return;
		}

		const notify = new Notifications();
		const loadNotificationId = notify.createNotificationId();
		notify.notifyProgress(loadNotificationId, "Loading ODRViewer application");
		
		const logLines = [];

		const tabName = `${path.basename(originalEditor.document.fileName)} - ODRViewer`;		
		const panel = vscode.window.createWebviewPanel('odrviewer', tabName,
			vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true } );
		const index = odrviewer.getWebViewIndexHtml(runtimeManager.getPaths());
		const panelSubscriptions = [];
		let panelDisposed = false;
		const disposePanelSubscriptions = () => {
			if (panelDisposed) { return; }
			panelDisposed = true;
			for (const subscription of panelSubscriptions) {
				subscription.dispose();
			}
		};
		panelSubscriptions.push(panel.onDidDispose(disposePanelSubscriptions));

		/**
		 * Subscribing to save event in workspace
		 */
		panelSubscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
			if (panelDisposed) { return; }
			if (document.uri != originalEditor.document.uri) { return; }

			const currentNotificationId = notify.createNotificationId();
			notify.notifyProgress(currentNotificationId, `Reloading ${originalEditor.document.uri}`);

			const documentText = document.getText();
			panel.webview.postMessage({
				command: "payload",
				payload: documentText,
				fileName: path.basename(document.fileName),
				notificationId: currentNotificationId
			});
		}));

		const onLoad = () => {
			notify.resolveProgress(loadNotificationId);

			const document = originalEditor.document;
			const currentNotificationId = notify.createNotificationId();
			notify.notifyProgress(currentNotificationId, `Loading ${document.uri}`);

			const documentText = document.getText();
			panel.webview.postMessage({
				command: "payload",
				payload: documentText,
				fileName: path.basename(document.fileName),
				notificationId: currentNotificationId
			});
		};

		const onLoadEnd = (message) => {
			notify.resolveProgress(message.notificationId);
		};

		const onError = (message) => {
			if (message.notificationId) {
				notify.resolveProgress(message.notificationId);
			} else {
				notify.resolveProgress(loadNotificationId);
			}
			notify.notifyError(message.message);
		}

		const onLog = (message) => {
			logLines.push(`[${message.level}] ${message.message}`);
			console.log(`[${message.level}] ${message.message}`);
		};

		const onOpenLog = async () => {
			const document = await vscode.workspace.openTextDocument({
				language: 'log',
				content: logLines.join('\n')
			});
			await vscode.window.showTextDocument(document, {
				viewColumn: vscode.ViewColumn.Beside,
				preview: true
			});
		};

		const onOpenEditor = async () => {
			await vscode.window.showTextDocument(originalEditor.document, {
				viewColumn: originalEditor.viewColumn,
				preserveFocus: false
			});
		};

		const onJumpToEditor = async (byteOffset) => {
			if (!Number.isInteger(byteOffset) || byteOffset < 0) { return; }
			const text = originalEditor.document.getText();
			let utf8Offset = 0;
			let utf16Offset = 0;
			while (utf16Offset < text.length && utf8Offset < byteOffset) {
				const codePoint = text.codePointAt(utf16Offset);
				const codePointLength = codePoint > 0xffff ? 2 : 1;
				const codePointBytes = Buffer.byteLength(String.fromCodePoint(codePoint), 'utf8');
				if (utf8Offset + codePointBytes > byteOffset) { break; }
				utf8Offset += codePointBytes;
				utf16Offset += codePointLength;
			}
			const editor = await vscode.window.showTextDocument(originalEditor.document, {
				viewColumn: originalEditor.viewColumn,
				preserveFocus: false
			});
			const position = originalEditor.document.positionAt(utf16Offset);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
		};

		panelSubscriptions.push(panel.webview.onDidReceiveMessage((message) => {
			if (panelDisposed) { return; }
			try {
				switch(message.command) {
					case 'load':
						onLoad();
						break;
					case 'loadEnd':
						onLoadEnd(message);
						break;
					case 'error':
						onError(message);
						break;
					case 'log':
						onLog(message);
						break;
					case 'openLog':
						onOpenLog().catch(error => console.error(error));
						break;
					case 'openEditor':
						onOpenEditor().catch(error => console.error(error));
						break;
					case 'jumpToEditor':
						onJumpToEditor(message.byteOffset).catch(error => console.error(error));
						break;
				}
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				console.error(`[ERROR] Webview message handling failed: ${text}`);
				vscode.window.showErrorMessage(`OpenDRIVE Viewer message error: ${text}`);
			}
		}));

		panel.webview.html = index;
	};

	const disposable = vscode.commands.registerCommand('opendrive-viewer.show', () => {
		try {
			openDriveViewerShow();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[ERROR] ${message}`);
			vscode.window.showErrorMessage(`OpenDRIVE Viewer failed to start: ${message}`);
		}
	});

	context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
	activate,
	deactivate
}
