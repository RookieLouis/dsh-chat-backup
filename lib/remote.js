import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

/** Register the plugin's operator-facing namespace through native SRC Remote methods. */
export function installRemote(ctx, { controller, lifecycle, sourceRoot, validateDestination }) {
  const initializers = [];
  class ChatBackupRemote extends TypertRemoteService {
    constructor(remoteCtx) {
      super(remoteCtx, 'dshChatBackup');
      // Apply the standard Remote decorators' instance initializers in plain JS.
      for (const initialize of initializers) initialize.call(this);
    }

    getState() {
      return controller.getState();
    }

    acknowledge(id) {
      if (typeof id !== 'string' || !id) throw new TypeError('A notification ID is required');
      return controller.acknowledge({ id });
    }

    async backupNow() {
      if (!lifecycle) return { state: 'disabled' };
      return await lifecycle.start('manual') ?? { state: 'unavailable' };
    }

    validateDestination(destinationRoot) {
      if (typeof destinationRoot !== 'string' || !destinationRoot.trim()) throw new TypeError('A backup destination is required');
      return validateDestination(sourceRoot, destinationRoot);
    }
  }
  for (const method of ['getState', 'acknowledge', 'backupNow', 'validateDestination']) {
    Remote(method)(ChatBackupRemote.prototype[method], {
      kind: 'method',
      name: method,
      static: false,
      private: false,
      addInitializer: initialize => initializers.push(initialize),
    });
  }
  // Cordis owns the child fiber and removes the service when this plugin unloads.
  return ctx.plugin(ChatBackupRemote);
}
