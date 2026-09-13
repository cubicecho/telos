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
