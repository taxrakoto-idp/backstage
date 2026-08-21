import {
  coreServices,
  createBackendModule,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';
import { readFile } from 'node:fs/promises';

type GiteaGitopsOptions = {
  baseUrl: string;
  publicBaseUrl: string;
  owner: string;
  repository: string;
  branch: string;
  token?: string;
};

function createGiteaGitopsFileAction(options: GiteaGitopsOptions) {
  return createTemplateAction({
    id: 'gitea:gitops:createFile',
    description:
      'Creates one rendered application values file in the platform GitOps repository.',
    supportsDryRun: true,
    schema: {
      input: {
        sourcePath: z =>
          z.string({ description: 'Rendered file inside the task workspace' }),
        filePath: z =>
          z
            .string({ description: 'Destination path in application-gitops' })
            .regex(
              /^apps\/[a-z][a-z0-9-]{1,61}[a-z0-9]\/(dev|staging|prod)\/values\.yaml$/,
              'must be apps/<application>/<environment>/values.yaml',
            ),
        commitMessage: z => z.string({ description: 'Git commit message' }),
      },
      output: {
        commitHash: z => z.string(),
        fileUrl: z => z.string(),
      },
    },
    async handler(ctx) {
      const sourcePath = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.sourcePath,
      );
      const content = await readFile(sourcePath, 'utf8');
      const fileUrl = `${options.publicBaseUrl}/${encodeURIComponent(
        options.owner,
      )}/${encodeURIComponent(
        options.repository,
      )}/src/branch/${encodeURIComponent(options.branch)}/${ctx.input.filePath
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/')}`;

      if (ctx.isDryRun) {
        ctx.logger.info(
          `Would create ${ctx.input.filePath} in application-gitops`,
        );
        ctx.output('commitHash', 'dry-run');
        ctx.output('fileUrl', fileUrl);
        return;
      }

      if (!options.token) {
        throw new Error(
          'GITEA_GITOPS_TOKEN is not configured in the Backstage backend',
        );
      }

      const apiUrl = `${options.baseUrl}/api/v1/repos/${encodeURIComponent(
        options.owner,
      )}/${encodeURIComponent(options.repository)}/contents`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `token ${options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          branch: options.branch,
          message: ctx.input.commitMessage,
          author: {
            name: 'gitops-bot',
            email: 'gitops-bot@local.domain',
          },
          committer: {
            name: 'gitops-bot',
            email: 'gitops-bot@local.domain',
          },
          files: [
            {
              operation: 'create',
              path: ctx.input.filePath,
              content: Buffer.from(content, 'utf8').toString('base64'),
            },
          ],
        }),
      });

      const responseText = await response.text();
      let responseBody: {
        commit?: { sha?: string };
        message?: string;
      } = {};
      if (responseText) {
        try {
          responseBody = JSON.parse(responseText);
        } catch {
          // Preserve a useful status-only error without logging credentials or
          // an unexpected response body returned by the remote service.
        }
      }

      if (!response.ok) {
        const detail = responseBody.message ? `: ${responseBody.message}` : '';
        throw new Error(
          `Gitea could not create ${ctx.input.filePath} (HTTP ${response.status})${detail}`,
        );
      }

      const commitHash = responseBody.commit?.sha;
      if (!commitHash) {
        throw new Error(
          'Gitea created the values file without returning a commit SHA',
        );
      }

      ctx.logger.info(`Created ${ctx.input.filePath} in application-gitops`);
      ctx.output('commitHash', commitHash);
      ctx.output('fileUrl', fileUrl);
    },
  });
}

export const giteaGitopsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'gitea-gitops',
  register(registerEnv) {
    registerEnv.registerInit({
      deps: {
        config: coreServices.rootConfig,
        scaffolderActions: scaffolderActionsExtensionPoint,
      },
      async init({ config, scaffolderActions }) {
        const actionConfig = config.getConfig('scaffolder.giteaGitops');
        scaffolderActions.addActions(
          createGiteaGitopsFileAction({
            baseUrl: actionConfig.getString('baseUrl').replace(/\/$/, ''),
            publicBaseUrl: actionConfig
              .getString('publicBaseUrl')
              .replace(/\/$/, ''),
            owner: actionConfig.getString('owner'),
            repository: actionConfig.getString('repository'),
            branch: actionConfig.getString('branch'),
            token: actionConfig.getOptionalString('token'),
          }),
        );
      },
    });
  },
});
