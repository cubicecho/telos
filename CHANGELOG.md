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
