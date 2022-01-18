/**
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import isEqual from "lodash/isEqual";
import { action, observable, reaction, when, makeObservable } from "mobx";
import { autoBind } from "../../utils";
import { createRelease, deleteRelease, HelmRelease, IReleaseCreatePayload, IReleaseUpdatePayload, listReleases, rollbackRelease, updateRelease } from "../../../common/k8s-api/endpoints/helm-releases.api";
import { ItemStore } from "../../../common/item.store";
import type { Secret } from "../../../common/k8s-api/endpoints";
import { secretsStore } from "../+config-secrets/secrets.store";
import type { NamespaceStore } from "../+namespaces/namespace-store/namespace.store";
import { Notifications } from "../notifications";

interface Dependencies {
  namespaceStore: NamespaceStore
}

export class ReleaseStore extends ItemStore<HelmRelease> {
  releaseSecrets = observable.map<string, Secret>();

  constructor(private dependencies: Dependencies ) {
    super();
    makeObservable(this);
    autoBind(this);

    when(() => secretsStore.isLoaded, () => {
      this.releaseSecrets.replace(this.getReleaseSecrets());
    });
  }

  watchAssociatedSecrets(): (() => void) {
    return reaction(() => secretsStore.getItems(), () => {
      if (this.isLoading) return;
      const newSecrets = this.getReleaseSecrets();
      const amountChanged = newSecrets.length !== this.releaseSecrets.size;
      const labelsChanged = newSecrets.some(([id, secret]) => (
        !isEqual(secret.getLabels(), this.releaseSecrets.get(id)?.getLabels())
      ));

      if (amountChanged || labelsChanged) {
        this.loadFromContextNamespaces();
      }
      this.releaseSecrets.replace(newSecrets);
    }, {
      fireImmediately: true,
    });
  }

  watchSelectedNamespaces(): (() => void) {
    return reaction(() => this.dependencies.namespaceStore.context.contextNamespaces, namespaces => {
      this.loadAll(namespaces);
    }, {
      fireImmediately: true,
    });
  }

  private getReleaseSecrets() {
    return secretsStore
      .getByLabel({ owner: "helm" })
      .map(s => [s.getId(), s] as const);
  }

  getReleaseSecret(release: HelmRelease) {
    return secretsStore.getByLabel({
      owner: "helm",
      name: release.getName(),
    })
      .find(secret => secret.getNs() == release.getNs());
  }

  @action
  async loadAll(namespaces: string[]) {
    this.isLoading = true;
    this.isLoaded = false;

    try {
      const items = await this.loadItems(namespaces);

      this.items.replace(this.sortItems(items));
      this.isLoaded = true;
      this.failedLoading = false;
    } catch (error) {
      this.failedLoading = true;
      console.warn("Loading Helm Chart releases has failed", error);

      if (error.error) {
        Notifications.error(error.error);
      }
    } finally {
      this.isLoading = false;
    }
  }

  async loadFromContextNamespaces(): Promise<void> {
    return this.loadAll(this.dependencies.namespaceStore.context.contextNamespaces);
  }

  async loadItems(namespaces: string[]) {
    const isLoadingAll = this.dependencies.namespaceStore.context.allNamespaces?.length > 1
      && this.dependencies.namespaceStore.context.cluster.accessibleNamespaces.length === 0
      && this.dependencies.namespaceStore.context.allNamespaces.every(ns => namespaces.includes(ns));

    if (isLoadingAll) {
      return listReleases();
    }

    return Promise // load resources per namespace
      .all(namespaces.map(namespace => listReleases(namespace)))
      .then(items => items.flat());
  }

  create = async (payload: IReleaseCreatePayload) => {
    const response = await createRelease(payload);

    if (this.isLoaded) this.loadFromContextNamespaces();

    return response;
  };

  async update(name: string, namespace: string, payload: IReleaseUpdatePayload) {
    const response = await updateRelease(name, namespace, payload);

    if (this.isLoaded) this.loadFromContextNamespaces();

    return response;
  }

  rollback = async (name: string, namespace: string, revision: number) => {
    const response = await rollbackRelease(name, namespace, revision);

    if (this.isLoaded) this.loadFromContextNamespaces();

    return response;
  };

  async remove(release: HelmRelease) {
    return super.removeItem(release, () => deleteRelease(release.getName(), release.getNs()));
  }

  async removeSelectedItems() {
    return Promise.all(this.selectedItems.map(this.remove));
  }
}
