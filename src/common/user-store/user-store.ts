/**
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { app } from "electron";
import semver from "semver";
import { action, computed, observable, reaction, makeObservable, isObservableArray, isObservableSet, isObservableMap } from "mobx";
import type { BaseStoreDependencies } from "../base-store";
import { BaseStore } from "../base-store";
import { getAppVersion } from "../utils/app-version";
import { kubeConfigDefaultPath } from "../kube-helpers";
import { getOrInsertSet, toggle, toJS, object } from "../../renderer/utils";
import { DESCRIPTORS } from "./preferences-helpers";
import type { UserPreferencesModel, StoreType } from "./preferences-helpers";
import type { SelectedUpdateChannel } from "../application-update/selected-update-channel/selected-update-channel.injectable";
import type { UpdateChannelId } from "../application-update/update-channels";
import type { Migrations } from "conf/dist/source/types";
import type { EmitEvent } from "../app-event-bus/emit-event.injectable";

export interface UserStoreModel {
  lastSeenAppVersion: string;
  preferences: UserPreferencesModel;
}

interface UserStoreDependencies extends BaseStoreDependencies {
  readonly selectedUpdateChannel: SelectedUpdateChannel;
  readonly migrations: Migrations<UserStoreModel> | undefined;
  emitEvent: EmitEvent;
}

export class UserStore extends BaseStore<UserStoreModel> /* implements UserStoreFlatModel (when strict null is enabled) */ {
  readonly displayName = "UserStore";

  constructor(protected readonly dependencies: UserStoreDependencies) {
    super(dependencies, {
      configName: "lens-user-store",
      migrations: dependencies.migrations,
    });

    makeObservable(this);
    this.load();
  }

  @observable lastSeenAppVersion = "0.0.0";

  /**
   * used in add-cluster page for providing context
   * @deprecated No longer used
   */
  @observable kubeConfigPath = kubeConfigDefaultPath;

  /**
   * @deprecated No longer used
   */
  @observable seenContexts = observable.set<string>();

  /**
   * @deprecated No longer used
   */
  @observable newContexts = observable.set<string>();

  @observable allowErrorReporting!: StoreType<typeof DESCRIPTORS["allowErrorReporting"]>;
  @observable allowUntrustedCAs!: StoreType<typeof DESCRIPTORS["allowUntrustedCAs"]>;
  @observable colorTheme!: StoreType<typeof DESCRIPTORS["colorTheme"]>;
  @observable terminalTheme!: StoreType<typeof DESCRIPTORS["terminalTheme"]>;
  @observable localeTimezone!: StoreType<typeof DESCRIPTORS["localeTimezone"]>;
  @observable downloadMirror!: StoreType<typeof DESCRIPTORS["downloadMirror"]>;
  @observable httpsProxy!: StoreType<typeof DESCRIPTORS["httpsProxy"]>;
  @observable shell!: StoreType<typeof DESCRIPTORS["shell"]>;
  @observable downloadBinariesPath!: StoreType<typeof DESCRIPTORS["downloadBinariesPath"]>;
  @observable kubectlBinariesPath!: StoreType<typeof DESCRIPTORS["kubectlBinariesPath"]>;
  @observable terminalCopyOnSelect!: StoreType<typeof DESCRIPTORS["terminalCopyOnSelect"]>;
  @observable terminalConfig!: StoreType<typeof DESCRIPTORS["terminalConfig"]>;
  @observable extensionRegistryUrl!: StoreType<typeof DESCRIPTORS["extensionRegistryUrl"]>;

  /**
   * Download kubectl binaries matching cluster version
   */
  @observable downloadKubectlBinaries!: StoreType<typeof DESCRIPTORS["downloadKubectlBinaries"]>;

  /**
   * Whether the application should open itself at login.
   */
  @observable openAtLogin!: StoreType<typeof DESCRIPTORS["openAtLogin"]>;

  /**
   * The column IDs under each configurable table ID that have been configured
   * to not be shown
   */
  @observable hiddenTableColumns!: StoreType<typeof DESCRIPTORS["hiddenTableColumns"]>;

  /**
   * Monaco editor configs
   */
  @observable editorConfiguration!: StoreType<typeof DESCRIPTORS["editorConfiguration"]>;

  /**
   * The set of file/folder paths to be synced
   */
  @observable syncKubeconfigEntries!: StoreType<typeof DESCRIPTORS["syncKubeconfigEntries"]>;

  @computed get isNewVersion() {
    return semver.gt(getAppVersion(), this.lastSeenAppVersion);
  }

  @computed get resolvedShell(): string | undefined {
    return this.shell || process.env.SHELL || process.env.PTYSHELL;
  }

  startMainReactions() {
    // open at system start-up
    reaction(() => this.openAtLogin, openAtLogin => {
      app.setLoginItemSettings({
        openAtLogin,
        openAsHidden: true,
        args: ["--hidden"],
      });
    }, {
      fireImmediately: true,
    });
  }

  /**
   * Checks if a column (by ID) for a table (by ID) is configured to be hidden
   * @param tableId The ID of the table to be checked against
   * @param columnIds The list of IDs the check if one is hidden
   * @returns true if at least one column under the table is set to hidden
   */
  isTableColumnHidden(tableId: string, ...columnIds: (string | undefined)[]): boolean {
    if (columnIds.length === 0) {
      return false;
    }

    const config = this.hiddenTableColumns.get(tableId);

    if (!config) {
      return false;
    }

    return columnIds.some(columnId => columnId && config.has(columnId));
  }

  /**
   * Toggles the hidden configuration of a table's column
   */
  toggleTableColumnVisibility(tableId: string, columnId: string) {
    toggle(getOrInsertSet(this.hiddenTableColumns, tableId), columnId);
  }

  @action
  resetTheme() {
    this.colorTheme = DESCRIPTORS.colorTheme.fromStore(undefined);
  }

  @action
  saveLastSeenAppVersion() {
    this.dependencies.emitEvent({ name: "app", action: "whats-new-seen" });
    this.lastSeenAppVersion = getAppVersion();
  }

  @action
  protected fromStore({ lastSeenAppVersion, preferences }: Partial<UserStoreModel> = {}) {
    this.dependencies.logger.debug("UserStore.fromStore()", { lastSeenAppVersion, preferences });

    if (lastSeenAppVersion) {
      this.lastSeenAppVersion = lastSeenAppVersion;
    }

    for (const [key, { fromStore }] of object.entries(DESCRIPTORS)) {
      const curVal = this[key];
      const newVal = fromStore((preferences)?.[key] as never) as never;

      if (isObservableArray(curVal)) {
        curVal.replace(newVal);
      } else if (isObservableSet(curVal) || isObservableMap(curVal)) {
        curVal.replace(newVal);
      } else {
        this[key] = newVal;
      }
    }

    // TODO: Switch to action-based saving instead saving stores by reaction
    if (preferences?.updateChannel) {
      this.dependencies.selectedUpdateChannel.setValue(preferences?.updateChannel as UpdateChannelId);
    }
  }

  toJSON(): UserStoreModel {
    const preferences = object.fromEntries(
      object.entries(DESCRIPTORS)
        .map(([key, { toStore }]) => [key, toStore(this[key] as never)]),
    ) as UserPreferencesModel;

    return toJS({
      lastSeenAppVersion: this.lastSeenAppVersion,

      preferences: {
        ...preferences,

        updateChannel: this.dependencies.selectedUpdateChannel.value.get().id,
      },
    });
  }
}
