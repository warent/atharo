// Backend
import formidable from "formidable";
import { type NextApiRequest, type NextApiResponse } from "next";
import { createId } from "@paralleldrive/cuid2";
import fs from "fs";
import yaml from "js-yaml";
import { spawn } from "child_process";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import denoTemplate from "./denoTemplate.txt";

export const config = {
  api: {
    bodyParser: false,
  },
};

type PluginDefinition = {
  version: number;
  id: string;
  name: string;
  description: string;
  commands: {
    [key: string]: {
      description: string;
      example: string;
      entry: string;
      parameters: {
        [key: string]: {
          description: string;
          type: string;
          required: boolean;
          options?: string[];
        };
      }[];
    };
  };
};

const deploy = async (req: NextApiRequest, res: NextApiResponse) => {
  const form = formidable({});
  try {
    const [_, files] = await form.parse(req);
    // Create folder with createid for unique ID
    const pluginId = createId();
    fs.mkdirSync(`./uploads/${pluginId}`, { recursive: true });
    Object.values(files).forEach((file) => {
      if (Array.isArray(file)) {
        file.forEach((f) => {
          if (!f.originalFilename) {
            return res.status(500).json({ error: "Filenames missing" });
            throw new Error("Original filename missing");
          }
          fs.renameSync(
            f.filepath,
            `./uploads/${pluginId}/${f.originalFilename}`
          );
        });
      }
    });

    if (!fs.existsSync(`uploads/${pluginId}/atharo.yaml`)) {
      return res.status(500).json({ error: "atharo.yaml missing" });
    }

    const pluginDefinition = yaml.load(
      fs.readFileSync(`uploads/${pluginId}/atharo.yaml`, "utf8")
    ) as PluginDefinition;

    const commandMap = [];

    for (const [name, command] of Object.entries(pluginDefinition.commands)) {
      if (!fs.existsSync(`uploads/${pluginId}/${command.entry}`)) {
        return res.status(500).json({ error: "Command entrypoint missing" });
      }
      commandMap.push({
        id: createId(),
        name,
      });
    }

    const newServerTemplate = (denoTemplate as string)
      .replace(
        "{{ imports }}",
        commandMap
          .map((v) => `import ${v.id} from "./${v.name}.ts";`)
          .join("\n")
      )
      .replace(
        "{{ routes }}",
        commandMap
          .map(
            (v) => `
        router.post("/${v.name}", async (ctx) => {
          const body = ctx.request.body({ type: 'json' });
          ctx.response.body = ${v.id}(body);
        });
      `
          )
          .join("\n")
      );

    fs.writeFileSync(`./uploads/${pluginId}/main.ts`, newServerTemplate);

    const projectUniqueToken = pluginId.substr(0, 4);

    const denoProject = pluginDefinition.name
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase();

    const denoOrgResult = await fetch(
      `https://dash.deno.com/orgs/${process.env.DENO_ORGANIZATION_ID}?_data_`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Cookie: `token=${process.env.DENO_DEPLOY_TOKEN || ""}`,
        },
      }
    );

    const denoOrg = await denoOrgResult.json();

    // Creating a new project
    if (!denoOrg?.projects?.find((p) => p.name == denoProject)) {
      const newProjectResult = await fetch(
        "https://dash.deno.com/_api/projects",
        {
          method: "POST",
          body: JSON.stringify({
            organizationId: process.env.DENO_ORGANIZATION_ID,
          }),
          headers: {
            "Content-Type": "application/json",
            Cookie: `token=${process.env.DENO_DEPLOY_TOKEN || ""}`,
          },
        }
      );

      const newProject = await newProjectResult.json();

      await fetch(
        `https://dash.deno.com/_api/projects/${newProject.id as string}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: denoProject,
          }),
          headers: {
            "Content-Type": "application/json",
            Cookie: `token=${process.env.DENO_DEPLOY_TOKEN || ""}`,
          },
        }
      );
    } else {
      // TODO: Ensure the user owns this existing project
    }

    const prc = spawn(
      "deployctl",
      ["deploy", `--project=${denoProject}`, `./main.ts`],
      {
        cwd: `./uploads/${pluginId}`,
        env: {
          ...process.env,
          DENO_DEPLOY_TOKEN: process.env.DENO_DEPLOY_TOKEN || "",
        },
      }
    );

    //noinspection JSUnresolvedFunction
    prc.stdout.setEncoding("utf8");
    prc.stdout.on("data", function (data) {
      const str = data.toString();
      const lines = str.split(/(\r?\n)/g);
      console.log(lines.join(""));
    });

    prc.on("close", function (code) {
      fs.rmdirSync(`./uploads/${pluginId}`, { recursive: true });

      if (code != 0) {
        res.status(500).end({ error: "Problem deploying files" });
        return;
      }

      res.status(200).end();
    });

    prc.on("error", function (err) {
      throw err;
    });
  } catch (err: any) {
    console.error(err);
    return res
      .status(err?.httpCode || 400)
      .json({ error: "Problem uploading files..." });
  }
};

export default deploy;
