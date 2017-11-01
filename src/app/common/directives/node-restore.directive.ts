/*!
 * @license
 * Copyright 2017 Alfresco Software, Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Directive, ElementRef, HostListener, Input } from '@angular/core';
import { Router } from '@angular/router';
import { Observable } from 'rxjs/Rx';

import { TranslationService, AlfrescoApiService, NotificationService } from 'ng2-alfresco-core';
import { MinimalNodeEntity, DeletedNodeEntry, PathInfoEntity, DeletedNodesPaging } from 'alfresco-js-api';

@Directive({
    selector: '[app-restore-node]'
})
export class NodeRestoreDirective {
    private restoreProcessStatus;

    @Input('app-restore-node')
    selection: MinimalNodeEntity[];

    @HostListener('click')
    onClick() {
        this.restore(this.selection);
    }

    constructor(
        private alfrescoApiService: AlfrescoApiService,
        private translation: TranslationService,
        private router: Router,
        private notification: NotificationService,
        private el: ElementRef
    ) {
        this.restoreProcessStatus = this.processStatus();
    }

    private restore(selection: any)  {
        if (!selection.length) {
            return;
        }

        const nodesWithPath = this.getNodesWithPath(selection);

        if (selection.length && !nodesWithPath.length) {
            this.restoreProcessStatus.fail.push(...selection);
            this.restoreNotification();
            this.refresh();
            return;
        }

        this.restoreNodesBatch(nodesWithPath)
            .do((restoredNodes) => {
                const status = this.processStatus(restoredNodes);

                this.restoreProcessStatus.fail.push(...status.fail);
                this.restoreProcessStatus.success.push(...status.success);
            })
            .flatMap(() => this.getDeletedNodes())
            .subscribe(
                (deletedNodesList: DeletedNodesPaging) => {
                    const { entries: nodelist } = deletedNodesList.list;
                    const { fail: restoreErrorNodes } = this.restoreProcessStatus;
                    const selectedNodes = this.diff(restoreErrorNodes, selection, false);
                    const remainingNodes = this.diff(selectedNodes, nodelist);

                    if (!remainingNodes.length) {
                        this.restoreNotification();
                        this.refresh();
                    } else {
                        this.restore(remainingNodes);
                    }
                }
            );
    }

    private restoreNodesBatch(batch: MinimalNodeEntity[]): Observable<MinimalNodeEntity[]> {
        return Observable.forkJoin(batch.map((node) => this.restoreNode(node)));
    }

    private getNodesWithPath(selection): MinimalNodeEntity[] {
        return selection.filter((node) => node.entry.path);
    }

    private getDeletedNodes(): Observable<DeletedNodesPaging> {
        const promise = this.alfrescoApiService.getInstance()
            .core.nodesApi.getDeletedNodes({ include: [ 'path' ] });

        return Observable.from(promise);
    }

    private restoreNode(node): Observable<any> {
        const { entry } = node;

        const promise = this.alfrescoApiService.getInstance().nodes.restoreNode(entry.id);

        return Observable.from(promise)
            .map(() => ({
                status: 1,
                entry
            }))
            .catch((error) => {
                const { statusCode } = (JSON.parse(error.message)).error;

                return Observable.of({
                    status: 0,
                    statusCode,
                    entry
                });
            });
    }

    private navigateLocation(path: PathInfoEntity) {
        const parent = path.elements[path.elements.length - 1];

        this.router.navigate([ '/personal-files',  parent.id ]);
    }

    private diff(selection , list, fromList = true): any {
        const ids = selection.map(item => item.entry.id);

        return list.filter(item => {
            if (fromList) {
                return ids.includes(item.entry.id) ? item : null;
            } else {
                return !ids.includes(item.entry.id) ? item : null;
            }
        });
    }

    private processStatus(data = []): any {
        const status = {
            fail: [],
            success: [],
            get someFailed() {
                return !!(this.fail.length);
            },
            get someSucceeded() {
                return !!(this.success.length);
            },
            get oneFailed() {
                return this.fail.length === 1;
            },
            get oneSucceeded() {
                return this.success.length === 1;
            },
            get allSucceeded() {
                return this.someSucceeded && !this.someFailed;
            },
            get allFailed() {
                return this.someFailed && !this.someSucceeded;
            },
            reset() {
                this.fail = [];
                this.success = [];
            }
        };

        return data.reduce(
            (acc, node) => {
                if (node.status) {
                    acc.success.push(node);
                } else {
                    acc.fail.push(node);
                }

                return acc;
            },
            status
        );
    }

    private getRestoreMessage(): Observable<string|any> {
        const { restoreProcessStatus: status } = this;

        if (status.someFailed && !status.oneFailed) {
            return this.translation.get(
                'APP.MESSAGES.ERRORS.TRASH.NODES_RESTORE.PARTIAL_PLURAL',
                {
                    number: status.fail.length
                }
            );
        }

        if (status.oneFailed && status.fail[0].statusCode) {
            if (status.fail[0].statusCode === 409) {
                return this.translation.get(
                    'APP.MESSAGES.ERRORS.TRASH.NODES_RESTORE.NODE_EXISTS',
                    {
                        name: status.fail[0].entry.name
                    }
                );
            } else {
                return this.translation.get(
                    'APP.MESSAGES.ERRORS.TRASH.NODES_RESTORE.GENERIC',
                    {
                        name: status.fail[0].entry.name
                    }
                );
            }
        }

        if (status.oneFailed && !status.fail[0].statusCode) {
            return this.translation.get(
                'APP.MESSAGES.ERRORS.TRASH.NODES_RESTORE.LOCATION_MISSING',
                {
                    name: status.fail[0].entry.name
                }
            );
        }

        if (status.allSucceeded && !status.oneSucceeded) {
            return this.translation.get('APP.MESSAGES.INFO.TRASH.NODES_RESTORE.PLURAL');
        }

        if (status.allSucceeded && status.oneSucceeded) {
            return this.translation.get(
                'APP.MESSAGES.INFO.TRASH.NODES_RESTORE.SINGULAR',
                {
                    name: status.success[0].entry.name
                }
            );
        }
    }

    private restoreNotification(): void {
        const status = Object.assign({}, this.restoreProcessStatus);
        const action = (status.oneSucceeded && !status.someFailed) ? 'View' : '';

        this.getRestoreMessage()
            .subscribe((message) => {
                this.notification.openSnackMessageAction(message, action, 3000)
                    .onAction()
                    .subscribe(() => this.navigateLocation(status.success[0].entry.path));
            });
    }

    private refresh(): void {
        this.restoreProcessStatus.reset();
        this.selection = [];
        this.emitDone();
    }

    private emitDone() {
        const e = new CustomEvent('selection-node-restored', { bubbles: true });
        this.el.nativeElement.dispatchEvent(e);
    }
}
