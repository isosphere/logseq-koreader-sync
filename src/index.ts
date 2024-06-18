import '@logseq/libs'
import { SettingSchemaDesc, BlockEntity, IBatchBlock, BlockUUID } from '@logseq/libs/dist/LSPlugin'
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
    authors = authors.replace(/\\\n/g, ', '); // this seems to be how KOReader stores multiple authors; at least from Calibre
  }
  
  if (!metadata.bookmarks) {
    return {
      content: `## ${metadata.doc_props.title}`,
      properties: {
        'authors': authors,
        'description': truncateString(metadata.doc_props.description, MAXIMUM_DESCRIPTION_LENGTH),
        'language': metadata.doc_props.language,
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
        content: `> ${bookmark.notes.replace('-', '\\-')}`, // escape dashes; they're used for lists in logseq
        properties: {
          'datetime': bookmark.datetime,
          'page': bookmark.page,
          'chapter': bookmark.chapter,
          'collapsed': COLLAPSE_BLOCKS && personal_note.length > 0,
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

      const currentPage = await logseq.Editor.getCurrentPage()
      if (currentPage?.originalName !== pageName) throw new Error('page error')

      const pageBlocksTree = await logseq.Editor.getCurrentPageBlocksTree()

      let targetBlock : BlockEntity | null = null;
      let warningBlockFound = false;
      for (const block of pageBlocksTree) {
        if (block?.content.includes("LKRS")) {
          targetBlock = block;
          continue;
        }
        else if (block?.content.includes("BEGIN_WARNING")) {
          warningBlockFound = true;
        }
      }

      if (!warningBlockFound) {
        await logseq.Editor.insertBatchBlock(currentPage.uuid, [{ content: "\n#+BEGIN_WARNING\nPlease do not edit this page; stick to block references made elsewhere.\n#+END_WARNING" }], { sibling: false})
      }

      const original_content = targetBlock?.content;
      if (targetBlock === null || targetBlock === undefined) {
        targetBlock = await logseq.Editor.insertBlock(currentPage.uuid, '🚀 LKRS: Please Select KOReader Metadata Directory ...',)
      } else {
        await logseq.Editor.updateBlock(targetBlock!.uuid, `🚀 LKRS: Please Select KOReader Metadata Directory ...`)
      }

      let directoryHandle : any = await getStorage('logseq_koreader_sync__directoryHandle');
      
      let permission;
      if (directoryHandle) {
        permission = await verifyPermission(directoryHandle);
      }

      if (!directoryHandle || !permission) {
        try {
          directoryHandle = await window.showDirectoryPicker() // get a DirectoryHandle that will allow us to read the contents of the directory
        } catch (e) {
          if (original_content) {
            await logseq.Editor.updateBlock(targetBlock!.uuid, original_content)
          } else {
            await logseq.Editor.updateBlock(targetBlock!.uuid, "# ❌ LKRS: Sync cancelled by user.")
          }
          console.error(e);
          return;
        }
        setStorage('logseq_koreader_sync__directoryHandle', directoryHandle);
      }        

      if (!directoryHandle) {
        console.error('No directory selected / found.')
        return; // something went wrong
      }

      await logseq.Editor.updateBlock(targetBlock!.uuid, `# ⚙ LKRS: Processing KOReader Annotations ...`)

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
          let block_uuid = block[0]["uuid"];
          if (block_uuid) {
            existingBlocks[key] = block_uuid;
          }
        }
      }

      const syncProgress = new ProgressNotification("Syncing Koreader Annotations to Logseq:", fileCount);
      for await (const fileHandle of walkDirectory(directoryHandle)) {
        var text = await fileHandle.text();
        var parsed_block = lua_to_block(text);

        if (parsed_block) {
          let key: string;
          if (parsed_block.properties!.authors === undefined) {
            key = "___" + parsed_block.content.substring(3);
          } else {
            key = parsed_block.properties!.authors + "___" + parsed_block.content.substring(3);
          }

          // Has this been synced before?
          if (key in existingBlocks) {             
            const existing_block = await logseq.Editor.getBlock(existingBlocks[key]);
            if (existing_block === null) {
              console.error("Block not found, but we also just found it - which is pretty weird: ", existingBlocks[key]);
              continue;
            }

            // find the bookmarks block
            let existing_bookmark_blocks;
            let existing_bookmark_block_uuid;

            for (const child of existing_block!.children!) {
              let child_block = await logseq.Editor.getBlock(child[1] as BlockEntity);

              if (child_block!.content === "### Bookmarks") {
                existing_bookmark_blocks = child_block!.children;
                existing_bookmark_block_uuid = child[1];

                break;
              }
            }

            if (existing_bookmark_blocks === undefined) {
              console.error("Bookmarks not found for block ", existingBlocks[key]);
              continue;
            }

            // iterate over bookmarks and build a dictionary for easy lookup
            let existing_bookmarks = {};
            for (const bookmark of existing_bookmark_blocks) {
              let bookmark_block = await logseq.Editor.getBlock(bookmark[1] as BlockEntity);

              const content_start = bookmark_block!.content!.indexOf("\n> ");     // not ideal
              const content = bookmark_block!.content!.substring(content_start+3).replace('-', '\-');

              existing_bookmarks[content] = bookmark[1];
            }

            // iterate over bookmarks in `block`, checking if they already exist
            // the first child of `parsed_block` is the "### Bookmarks" block
            for (const bookmark of parsed_block.children![0].children!) {
              let key = bookmark.content.substring(2);

              // does this parsed block have a personal note?
              let parsed_personal_note = false;
              if (bookmark.children && bookmark.children.length > 0) {
                parsed_personal_note = true;
              }

              // existing bookmark, check personal note
              if (key in existing_bookmarks) {
                let existing_bookmark = await logseq.Editor.getBlock(existing_bookmarks[key]);
                
                // personal note exists in graph
                if (existing_bookmark!.children && existing_bookmark!.children!.length > 0) {
                  let existing_note = existing_bookmark!.children![0];

                  if (!parsed_personal_note) {
                    // delete it
                    await logseq.Editor.removeBlock(existing_note[1] as BlockUUID);
                  } else {
                    let existing_note_block = await logseq.Editor.getBlock(existing_note[1] as BlockEntity);

                    // if the existing note is different, update it
                    if (existing_note_block!.content !== bookmark.children![0].content) {
                      await logseq.Editor.updateBlock(existing_note[1] as string, bookmark.children![0].content);
                    }
                  }
                } 
                // personal note does not exist in graph
                else {
                  // add it
                  if (parsed_personal_note) {
                    await logseq.Editor.insertBatchBlock(existing_bookmark!.uuid, [bookmark.children![0]], {
                      sibling: false
                    })
                  }
                }
              } 
              // new bookmark, add it
              else {
                await logseq.Editor.insertBatchBlock(existing_bookmark_block_uuid, [bookmark], {
                  sibling: false
                })
              }
            }
          } else {
            await logseq.Editor.insertBatchBlock(targetBlock!.uuid, [parsed_block], {
              sibling: false
            })
          }
        }
        syncProgress.increment(1);
      }

      await logseq.Editor.updateBlock(targetBlock!.uuid, `# 📚 LKRS: KOReader - Sync Initiated at ${syncTimeLabel}`)
      
      syncProgress.destruct();
      loading = false
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