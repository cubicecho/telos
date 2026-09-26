# [1.3.0](https://github.com/cubicecho/telos/compare/v1.2.0...v1.3.0) (2026-09-26)


### Features

* **app:** pick a palette in Settings ([823b1e7](https://github.com/cubicecho/telos/commit/823b1e78ca280433ff816c9a4dfc8fd281bc8847))

# [1.2.0](https://github.com/cubicecho/telos/compare/v1.1.0...v1.2.0) (2026-09-25)


### Bug Fixes

* a long thread keeps the todo dialog's title and Save on screen ([362eae2](https://github.com/cubicecho/telos/commit/362eae245ffc2d0270d6d420d755ff68f1f2fe16))
* a moved lane or card keeps its place after a refetch ([7d714e5](https://github.com/cubicecho/telos/commit/7d714e57c38d8baefc3dc04e59a2d8a87909b8d0))
* an agent records only what its tools stored, and its notes link to the thread ([1e47750](https://github.com/cubicecho/telos/commit/1e477504904c725d4e17829840031e6e83d0c337))
* **app:** room for focus rings in the agent form's scroll area ([4c923fa](https://github.com/cubicecho/telos/commit/4c923fa7a0d64c9dc97cad357ef8677b7dd15b04))
* quiet Apollo's list warnings, and stop refetching a tab that isn't open ([90b161c](https://github.com/cubicecho/telos/commit/90b161cbfb19eb858ea2e1821763a646b6c36cda))


### Features

* a project with AI off shows none of its runs or artifacts ([b60b4ce](https://github.com/cubicecho/telos/commit/b60b4ce833b4a46abb2b5ebd5cd8c7caa9391009))
* a stations page, and retry and stop from the board ([bef3a36](https://github.com/cubicecho/telos/commit/bef3a360116e5505ff1665aa7eca4d5429c1d1f5))
* an admin's instance AI switch in Settings ([22a7fd7](https://github.com/cubicecho/telos/commit/22a7fd71a2441f6b917d588cc74607c9781e0d09))
* **app:** a todo's history shows its runs, and notes and moves open the run that made them ([e0eea18](https://github.com/cubicecho/telos/commit/e0eea1878f139e646c7bae1871bcad855edaf74c))
* **app:** agents, stations, and a todo's runs and artifacts ([26e7faf](https://github.com/cubicecho/telos/commit/26e7fafa6ec706ff1c490395986ef761afddba45))
* **app:** AI settings in their own tab ([23270b5](https://github.com/cubicecho/telos/commit/23270b538417a443632c64d10530a98650f0f72f))
* **app:** keep the project header and list in the reading column, the board full width ([bb332ef](https://github.com/cubicecho/telos/commit/bb332efa05a034bcd970092a4bda4815a179f52f))
* **app:** todo notes, history and acceptance; AI switches and API keys ([832fedf](https://github.com/cubicecho/telos/commit/832fedf50ecca8fca4fbe894f7cf0c06f8aa9ea4))
* archive todos, restore them, or delete them for good ([1d0ae59](https://github.com/cubicecho/telos/commit/1d0ae5924cb0f9b5360d218fbd436f1dbe0edfd7))
* boards update live as their todos and lanes change ([37da2e4](https://github.com/cubicecho/telos/commit/37da2e4e26ebf1a09fce96a91ae3b471078f0732))
* find any todo with Ctrl+K ([e75509e](https://github.com/cubicecho/telos/commit/e75509e0646f4010137161de71ccfc415f2b8b55))
* MCP prompts that explain the board and walk through handing it work ([c8ec603](https://github.com/cubicecho/telos/commit/c8ec6032cfdd19728c3c69fcceccddbf7a6eca85))
* pick an agent's model from what its endpoint lists ([4f8d016](https://github.com/cubicecho/telos/commit/4f8d01666e31e43ec779e598fcc2506868dc518e))
* prune old runs after the account's retention ([62e2e1a](https://github.com/cubicecho/telos/commit/62e2e1ad8bc6f1dcd384f0ac5fc78cc29da01226))
* **runner:** hooks, artifacts and a live event feed ([764f880](https://github.com/cubicecho/telos/commit/764f8800ea7bd6bc1b8b6a00aaf1d8ae82348641))
* **runner:** the runner that works the stations ([3d44779](https://github.com/cubicecho/telos/commit/3d44779b88fff92d795ee85de6bdd4f7f7ffe017))
* save a board's lanes as a template and start projects from it ([618ecfe](https://github.com/cubicecho/telos/commit/618ecfe751ce9d16555da774afc1ea108149533f))
* **scripts:** import a kanban_server board ([bccde1e](https://github.com/cubicecho/telos/commit/bccde1ebe7b92048467195fd4119b9c5b4c9f129))
* **scripts:** make an account an admin ([2f129bb](https://github.com/cubicecho/telos/commit/2f129bbc498b945c69add327f1311dbb6fdded96))
* **server:** agents, lanes as stations, and runs ([24a06fc](https://github.com/cubicecho/telos/commit/24a06fcf1d40cc9ebed33dbbaab7c280099a1dba))
* **server:** better-auth sessions, API keys and the AI switches ([6d9bd28](https://github.com/cubicecho/telos/commit/6d9bd28eaf399c6dfea921ece553e013b1d8d14f))
* **server:** run events and artifacts ([eeb3b3d](https://github.com/cubicecho/telos/commit/eeb3b3d41fca321435d5a49f9073f79cd170b3bc))
* **server:** the MCP door, where AI hands work to the board ([5f3a007](https://github.com/cubicecho/telos/commit/5f3a0070c440c1a562e0d9a7656371cac9e1184f))
* **server:** todo history, notes, acceptance, parents and project AI switch ([d99e768](https://github.com/cubicecho/telos/commit/d99e7684066cac40bc0b9ef2bc143ffd4d17817a))
* stopping a run tells AI to ignore its todo ([12a7424](https://github.com/cubicecho/telos/commit/12a742416892579333ba62bfd01af45595195e9c))
* take an artifact off the board, leaving what it points at ([ae465a4](https://github.com/cubicecho/telos/commit/ae465a4d4d1db7eaff7cc94e73bad5c9cbeedbc3))
* talk a request over with an agent before it becomes a todo ([406861b](https://github.com/cubicecho/telos/commit/406861be42d17b7347df0d23029b69d4371e5af4))
* test an agent's MCP server from its form ([455e8dd](https://github.com/cubicecho/telos/commit/455e8dd034997fc022fd79b678eaa4d31e9e3e0f))
* the runner comes with the server, no key to set ([73c919e](https://github.com/cubicecho/telos/commit/73c919e6a81dea0b5531326c6ca874c8698f8cd9))
* watch what the AI is doing ([c4a1a82](https://github.com/cubicecho/telos/commit/c4a1a820eadf88cbc7ba2eebdd244bb37ae01a98))

# [1.1.0](https://github.com/cubicecho/telos/compare/v1.0.0...v1.1.0) (2026-09-25)


### Bug Fixes

* **app:** keep the picked date in the due-date trigger's name ([0cc81bd](https://github.com/cubicecho/telos/commit/0cc81bdba3a25e41df934cca761bc48522e47391)), closes [#112](https://github.com/cubicecho/telos/issues/112)


### Features

* **app:** build the UI on cubeui's native registry ([7d54a97](https://github.com/cubicecho/telos/commit/7d54a97ac097cec1e1660246f9c2220b023b54bb))
* **app:** drop the last local cubeui patches ([cc83187](https://github.com/cubicecho/telos/commit/cc831877399ad795f2fff4ffd9e755c6d8bf4198)), closes [cubeui#101](https://github.com/cubeui/issues/101) [#102](https://github.com/cubicecho/telos/issues/102) [#103](https://github.com/cubicecho/telos/issues/103) [cubeui#101](https://github.com/cubeui/issues/101) [cubeui#102](https://github.com/cubeui/issues/102) [cubeui#103](https://github.com/cubeui/issues/103) [cubeui#111](https://github.com/cubeui/issues/111)
* **app:** form dialogs use cubeui's native Form ([922125a](https://github.com/cubicecho/telos/commit/922125af1c4eee0b410e859cf8f47b195a953e02)), closes [cubicecho/cubeui#115](https://github.com/cubicecho/cubeui/issues/115)
* **app:** lists take cubeui's QueryState rungs ([ca13521](https://github.com/cubicecho/telos/commit/ca13521d3abc57893c4af1491b088eaa33930884)), closes [cubicecho/cubeui#113](https://github.com/cubicecho/cubeui/issues/113) [#114](https://github.com/cubicecho/telos/issues/114)
* **app:** move onto cubeui's Menu, Badge onRemove and createAppForm ([4b283f6](https://github.com/cubicecho/telos/commit/4b283f6b7f5feb1727bebbc943911183088165dd)), closes [cubicecho/cubeui#116](https://github.com/cubicecho/cubeui/issues/116) [#117](https://github.com/cubicecho/telos/issues/117) [#118](https://github.com/cubicecho/telos/issues/118) [cubicecho/cubeui#119](https://github.com/cubicecho/cubeui/issues/119)
* **app:** pick up cubeui's fixes, and edit due dates with its date picker ([a2ba2f0](https://github.com/cubicecho/telos/commit/a2ba2f020367615fc45642db13b9193a4d4bec14)), closes [cubeui#95](https://github.com/cubeui/issues/95) [cubeui#96](https://github.com/cubeui/issues/96) [cubeui#97](https://github.com/cubeui/issues/97) [cubeui#87](https://github.com/cubeui/issues/87) [cubeui#88](https://github.com/cubeui/issues/88)
* **app:** screens on cubeui's PageLayout and friends ([e439ee4](https://github.com/cubicecho/telos/commit/e439ee4172120ca654e0b0ff00ecde0d00cb3931))
* **app:** take cubeui's tabs and QueryError, and drop the fixed local patches ([9bec86f](https://github.com/cubicecho/telos/commit/9bec86f83bab607eb5be265bb5607bd635becadf)), closes [#84](https://github.com/cubicecho/telos/issues/84) [#89](https://github.com/cubicecho/telos/issues/89) [#90](https://github.com/cubicecho/telos/issues/90) [cubeui#82](https://github.com/cubeui/issues/82) [#83](https://github.com/cubicecho/telos/issues/83) [#85](https://github.com/cubicecho/telos/issues/85) [cubeui#96](https://github.com/cubeui/issues/96) [#86](https://github.com/cubicecho/telos/issues/86)
* **app:** take the theme picker from cubeui, and pick up its border fix ([cce2b14](https://github.com/cubicecho/telos/commit/cce2b1403a3ddaa3933a1818f07124f95209e1b9)), closes [cubeui#80](https://github.com/cubeui/issues/80)


### Reverts

* **app:** put sidebar.tsx back to the registry's copy ([d036185](https://github.com/cubicecho/telos/commit/d036185d1b1b8be8dbab1c3937d2dc3ba950342e))

# 1.0.0 (2026-09-13)


### Bug Fixes

* **app:** declare relation lists as replaced, not merged ([6c9e69b](https://github.com/cubicecho/telos/commit/6c9e69b17046eafe872e9c0ac5ac37b71fe6df44))
* let the dev client reach the API over the network ([6844cd0](https://github.com/cubicecho/telos/commit/6844cd0b8cc1e76889f4986526a4b70f459efae1))
* make the dev database reachable from a remote Docker daemon ([3b40e11](https://github.com/cubicecho/telos/commit/3b40e118be8b59766dd1fd9104a61b84df580587))
* make the todo checkbox a square with a hover preview tick ([935b389](https://github.com/cubicecho/telos/commit/935b389d9af71459d6b745cd48e8178e9de9cdff))
* pick label badge text by contrast, not by the label colour ([cd7fe6a](https://github.com/cubicecho/telos/commit/cd7fe6acf948a41ecc7de284a8c092c650c4f42d))


### Features

* add a settings screen with a theme selector ([193c3ce](https://github.com/cubicecho/telos/commit/193c3ce723b363d5d57d10ac84fa4deced8ba1f2))
* **app:** complete and delete todos optimistically ([346cb95](https://github.com/cubicecho/telos/commit/346cb958442ca1af2f19e5a07dc6b5a7fa78bcc8))
* **app:** find a todo, and reach it from the keyboard ([68ada0f](https://github.com/cubicecho/telos/commit/68ada0f05e15929aace8ab1fc5f0eaa4858059d1))
* **app:** gather row actions into one icon cluster ([40d26ae](https://github.com/cubicecho/telos/commit/40d26aef887bdfb4b08f1da7d374bc9ca71103da))
* **app:** let a todo be edited ([c2c4d86](https://github.com/cubicecho/telos/commit/c2c4d86d18bd7d1d757cf02c99cb864e4c4dbb35))
* **app:** say what failed instead of showing an empty list ([a9850f0](https://github.com/cubicecho/telos/commit/a9850f0b37b69d56cd87bd614b666e3d1762784b))
* **board:** add a kanban view to the project screen ([c145532](https://github.com/cubicecho/telos/commit/c145532a5f6dcf3641f709c37768612ad11e9543))
* **board:** keep a blocked todo in the column it is in ([1bb8622](https://github.com/cubicecho/telos/commit/1bb8622b65fc300278100999fe11d694f0f6aa79))
* **db:** give a todo notes and a due date ([2034277](https://github.com/cubicecho/telos/commit/203427769ba6d4b5494fa5f48de3737059b05ea6))
* **db:** index todos by due date ([2c35c31](https://github.com/cubicecho/telos/commit/2c35c31b37bdc549da48073f630ce89b615d5114))
* default to port 3000 for the client and 3001 for the API ([78f15f8](https://github.com/cubicecho/telos/commit/78f15f8c1c8b23b32d40aff0610a77c2f20177e5))
* give the sidebar a labelled new-project button and a rule under the heading ([2bcb35e](https://github.com/cubicecho/telos/commit/2bcb35ee9817dee0a4a5cf404a82d6ad1a1a45df))
* initial Telos scaffold ([03521b9](https://github.com/cubicecho/telos/commit/03521b9224337514f64414e38c178e37549f7ccb))
* **lanes:** add user-defined lanes with one marking work done ([805c487](https://github.com/cubicecho/telos/commit/805c487c859d18241f07b35917671aa859192092))


### Performance Improvements

* write new rows to the cache before the request leaves ([c6c0969](https://github.com/cubicecho/telos/commit/c6c096920ad7b0c618b9e43df00cbfadb1832c4f))
