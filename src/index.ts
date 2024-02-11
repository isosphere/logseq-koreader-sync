import '@logseq/libs'
import { SettingSchemaDesc, BlockEntity, IBatchBlock } from '@logseq/libs/dist/LSPlugin'
import { parse as luaparse } from 'luaparse'
import { ProgressNotification } from './progress'
import { get as getStorage, set as setStorage } from 'idb-keyval';

let settings: SettingSchemaDesc[] = []

const delay = (t = 100) => new Promise(r => setTimeout(r, t))

function truncateString(str, length) {
  if (!str) {
      return '';
  }

  if (str.length > length) {
      return str.slice(0, length);
  } else {
      return str;
  }
}

const MAXIMUM_DESCRIPTION_LENGTH = 250; // FIXME: this should be a setting
const COLLAPSE_BLOCKS = true; // FIXME: this should be a setting

function metadata_to_block(metadata: any): IBatchBlock | null {
  let bookmarks: IBatchBlock[] = [];

  if (metadata.doc_props === 'object' && Object.keys(metadata.doc_props).length === 0) {
    return null;
  }

  if (typeof metadata.bookmarks === 'object' && Object.keys(metadata.bookmarks).length === 0) {
    return null;
  }

  let authors = metadata.doc_props.authors;
  if (authors) {
    authors = authors.replace(/\\\n/g, ','); // this seems to be how KOReader stores multiple authors; at least from Calibre
  }
  
  if (!metadata.bookmarks) {
    return {
      content: `## ${metadata.doc_props.title}`,
      properties: {
        'authors': authors,
        'description': truncateString(metadata.doc_props.description, MAXIMUM_DESCRIPTION_LENGTH),
        'language': metadata.doc_props.language,
        'collapsed': COLLAPSE_BLOCKS,
      }
    }
  }

  for (const bookmark of metadata.bookmarks) {
    let personal_note: IBatchBlock[] = [];
    if (bookmark.text) {
      personal_note.push({
        content: bookmark.text,
      });
    }

    bookmarks.push(
      {
        content: `> ${bookmark.notes}`,
        properties: {
          'datetime': bookmark.datetime,
          'page': bookmark.page,
          'chapter': bookmark.chapter,
          'collapsed': COLLAPSE_BLOCKS,
        },
        children: personal_note
      }
    )
  }

  return {
    content: `## ${metadata.doc_props.title}`,
    properties: {
      'authors': authors,
      'description': truncateString(metadata.doc_props.description, MAXIMUM_DESCRIPTION_LENGTH),
      'language': metadata.doc_props.language,
      'collapsed': COLLAPSE_BLOCKS,
    },
    children: [
      {
        content: `### Bookmarks`,
        children: bookmarks
      }
    ]
  }
}

function lua_to_block(text: string): IBatchBlock | null {
  const ast = luaparse(text, {
    comments: false,
    locations: false,
    ranges: false,
    luaVersion: 'LuaJIT'
  });

  var metadata = {};

  for (const field in (ast.body[0] as any).arguments[0].fields) {
    const target = (ast.body[0] as any).arguments[0].fields[field]
    const key = target.key.raw.replace(/"/g, '');

    // it's easier to skip some fields
    if (key === "stats") {
      continue;
    }

    if (target.value.type === "TableConstructorExpression") {
      if (target.value.fields[0] && target.value.fields[0].value.type === "TableConstructorExpression") {
        metadata[key] = [];
      } else {
        metadata[key] = {};
      }

      for (const subfield in target.value.fields) {
        const subtarget = target.value.fields[subfield];
        if (subtarget.value.type === "TableConstructorExpression") {
          const sub_dictionary = {};
          
          for (const subsubfield in subtarget.value.fields) {
            const subsubtarget = subtarget.value.fields[subsubfield];
            const subkey = subsubtarget.key.raw.replace(/"/g, '');
            sub_dictionary[subkey] = subsubtarget.value.raw?.replace(/"/g, '');
          }
          metadata[key].push(sub_dictionary);
        } else {
          metadata[key][subtarget.key.raw.replace(/"/g, '')] = subtarget.value.raw?.replace(/"/g, '');
        }
      }
    } else {
      metadata[key] = target.value.raw?.replace(/"/g, '');
    }
  }

  return metadata_to_block(metadata);
}


async function* walkDirectory(directoryHandle: any) { // DirectoryHandle
  if (directoryHandle.kind === "file") {
    const file = await directoryHandle.getFile();
    if (file !== null && file.name.toLowerCase().endsWith('.lua') && file.name.toLowerCase().includes('metadata')) {
      yield file;
    }
  } else if (directoryHandle.kind === "directory") {
    for await (const handle of directoryHandle.values()) {
      yield* walkDirectory(handle);
    }
  }
}

// https://developer.chrome.com/docs/capabilities/web-apis/file-system-access#stored_file_or_directory_handles_and_permissions
async function verifyPermission(fileHandle) {
  // Check if permission was already granted. If so, return true.
  if ((await fileHandle.queryPermission({})) === 'granted') {
    return true;
  }
  // Request permission. If the user grants permission, return true.
  if ((await fileHandle.requestPermission({})) === 'granted') { // should work, won't work until Electron or logseq or something supports it
    return true;
  }
  // The user didn't grant permission, so return false.
  return false;
}

declare global {
  interface Window {
    showDirectoryPicker: any; // DirectoryHandle
  }
}

/**
 * main entry
 * @param baseInfo
 */
function main () {
  let loading = false;

  logseq.useSettingsSchema(settings)
  logseq.provideModel({
    async syncKOReader () {
      const info = await logseq.App.getUserConfigs()
      if (loading) return
  
      const pageName = '_logseq-koreader-sync'
      const syncTimeLabel = (new Date()).toLocaleString() // date and time as of now
  
      logseq.App.pushState('page', { name: pageName })
  
      await delay(300)
  
      loading = true

      try {
        const currentPage = await logseq.Editor.getCurrentPage()
        if (currentPage?.originalName !== pageName) throw new Error('page error')
  
        const pageBlocksTree = await logseq.Editor.getCurrentPageBlocksTree()

        let targetBlock : BlockEntity | null = pageBlocksTree[0]!

        if (targetBlock === null || targetBlock === undefined) {
          targetBlock = await logseq.Editor.insertBlock(currentPage.uuid, '🚀 Please Select KOReader Metadata Directory ...',)
        } else {
          await logseq.Editor.updateBlock(targetBlock!.uuid, `🚀 Please Select KOReader Metadata Directory ...`)
        }

        let directoryHandle : any = await getStorage('logseq_koreader_sync__directoryHandle');
        
        let permission;
        if (directoryHandle) {
          permission = await verifyPermission(directoryHandle);
        }

        if (!directoryHandle || !permission) {
          directoryHandle = await window.showDirectoryPicker() // get a DirectoryHandle that will allow us to read the contents of the directory
          setStorage('logseq_koreader_sync__directoryHandle', directoryHandle);
        }        

        if (!directoryHandle) {
          console.error('No directory selected / found.')
          return; // user cancelled, or something went wrong
        }

        // FIXME: change the max value to the number of files in the directory
        let fileCount = 0;
        for await (const _ of walkDirectory(directoryHandle)) { fileCount++; };

        // iterate over all blocks in this target page, and collect the titles, authors, and uuids and place them in a dictionary
        let ret;
        try {
          ret = await logseq.DB.datascriptQuery(`
          [
              :find (pull ?b [:block/content :block/uuid]) ?authors
              :where
                [?b :block/parent ?p]
                [?p :block/uuid #uuid "${targetBlock!.uuid}"]
                [?b :block/properties ?props]
                [(get ?props :authors) ?authors]
          ]
          `)
        } catch (e) {
          console.error("Error while iterating over blocks in the target page: ", e);
          return;
        }

        const titleMatch : RegExp = /##\s+(.*?)\n/;

        let existingBlocks = {}
        for (const block of ret) {
          const authors = block[1];
          const content = block[0]["content"];
          const match = content?.match(titleMatch);
          let title = match[1];

          const key = authors + "___" +  title;
          if (!(key in existingBlocks)) {
            existingBlocks[key] = block[0]["uuid"];
          }
        }

        const syncProgress = new ProgressNotification("Syncing Koreader Annotations to Logseq:", fileCount);
        for await (const fileHandle of walkDirectory(directoryHandle)) {
          var text = await fileHandle.text();
          var block = lua_to_block(text);

          if (block) {
            const key = block.properties!.authors + "___" + block.content.substring(3);

            if (key in existingBlocks) {             
              await logseq.Editor.updateBlock(existingBlocks[key], block.content, block.properties);
              
              // enumerate block children, and evaluate if they need updating
              // TODO


            } else {
              await logseq.Editor.insertBatchBlock(targetBlock!.uuid, [block], {
                sibling: false
              })
            }
          }
          syncProgress.increment(1);
        }

        await logseq.Editor.updateBlock(targetBlock!.uuid, `# 📚 KOReader - Sync Started at ${syncTimeLabel}`)
        syncProgress.destruct();
      } catch (e) {
        logseq.UI.showMsg(e.toString(), 'warning')
        console.error(e)
      } finally {
        loading = false
      }
    }
  })

  logseq.App.registerUIItem('toolbar', {
    key: 'koreader-sync',
    template: `
      <a data-on-click="syncKOReader" class="button">
        <i class="ti ti-book"></i>
      </a>
    `
  })
}

// bootstrap
logseq.ready(main).catch(console.error)