export class ProgressNotification {
    max: number;
    current: number;
    progressBar: HTMLElement | null;

    constructor(msg: string, max: number) {
        this.max = max;
        this.current = 0;
        logseq.provideUI({
            key: `logseq-koreader-sync-progress-notification-${logseq.baseInfo.id}`,
            path: "div.notifications",
            template: `
                <div class="ui__notifications-content enter-done" style="">
                    <div class="max-w-sm w-full shadow-lg rounded-lg pointer-events-auto notification-area transition ease-out duration-300 transform translate-y-0 opacity-100 sm:translate-x-0">
                        <div class="rounded-lg shadow-xs" style="max-height: calc(100vh - 200px); overflow: hidden scroll;">
                            <div class="p-4">
                                <div class="flex items-start">
                                    <div class="ml-3 w-0 flex-1">
                                        <div class="text-sm leading-5 font-medium whitespace-pre-line " style="margin: 0px;">${msg}
                                            <progress id="logseq-koreader-sync-progress-bar-${logseq.baseInfo.id}" value="${
                                                this.current
                                            }" max="${this.max}" style="width: 62%;" />
                                        </div>
                                    </div>
                                    <div class="ml-4 flex-shrink-0 flex">
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `,
        });
        logseq.provideStyle(`
        #logseq-koreader-sync-progress-bar-${logseq.baseInfo.id}::-webkit-progress-bar {
            border-radius: 7px; 
        }
        #logseq-koreader-sync-progress-bar-${logseq.baseInfo.id}::-webkit-progress-value {
            border-radius: 7px; 
            background-color: var(--ls-link-text-color,#045591);
        }
        `);
    }

    increment(amount = 1) {
        this.current += amount;
        try {
            if (this.progressBar == null) {
                this.progressBar = window.parent.document.getElementById(
                    `logseq-koreader-sync-progress-bar-${logseq.baseInfo.id}`,
                );
            }
            if (this.progressBar === null) {
                console.error("Progress bar not found");
                return;
            }

            this.progressBar.setAttribute("value", `${this.current}`);
        } catch (e) {}
    }

    destruct() {
        logseq.provideUI({
            key: `logseq-koreader-sync-progress-notification-${logseq.baseInfo.id}`,
            template: ``,
        });
        this.progressBar = null;
    }
}