"""Recipe persistence + versioning API.

All routes are scoped to the cookie-based anonymous owner. Recipes owned by a
different session are invisible (404) to the caller.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import AnonSession, Recipe, RecipeVersion
from app.owner import get_owner

router = APIRouter(prefix="/recipes", tags=["recipes"])


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class RecipeCreate(BaseModel):
    name: str
    script: str
    params: Any = Field(default_factory=list)
    param_values: Any = Field(default_factory=dict)
    inputs: Any = Field(default_factory=list)
    prompt: Optional[str] = None


class VersionCreate(BaseModel):
    script: str
    params: Any = Field(default_factory=list)
    param_values: Any = Field(default_factory=dict)
    inputs: Any = Field(default_factory=list)
    prompt: Optional[str] = None


class RecipeRename(BaseModel):
    name: str


class CurrentVersion(BaseModel):
    id: str
    version_no: int
    script: str
    params: Any
    param_values: Any = Field(default_factory=dict)
    inputs: Any
    prompt: Optional[str] = None
    created_at: datetime


class RecipeDetail(BaseModel):
    id: str
    name: str
    current_version_id: Optional[str]
    created_at: datetime
    updated_at: datetime
    current_version: Optional[CurrentVersion] = None


class RecipeListItem(BaseModel):
    id: str
    name: str
    version_count: int
    updated_at: datetime


class VersionListItem(BaseModel):
    id: str
    version_no: int
    created_at: datetime
    prompt: Optional[str] = None


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _get_owned_recipe(db: Session, owner: AnonSession, recipe_id: str) -> Recipe:
    recipe = db.get(Recipe, recipe_id)
    if recipe is None or recipe.owner_anon_id != owner.id:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return recipe


def _current_version_schema(db: Session, recipe: Recipe) -> Optional[CurrentVersion]:
    if recipe.current_version_id is None:
        return None
    v = db.get(RecipeVersion, recipe.current_version_id)
    if v is None:
        return None
    return CurrentVersion(
        id=v.id,
        version_no=v.version_no,
        script=v.script,
        params=v.params_json,
        param_values=v.param_values_json,
        inputs=v.inputs_json,
        prompt=v.prompt,
        created_at=v.created_at,
    )


def _detail(db: Session, recipe: Recipe) -> RecipeDetail:
    return RecipeDetail(
        id=recipe.id,
        name=recipe.name,
        current_version_id=recipe.current_version_id,
        created_at=recipe.created_at,
        updated_at=recipe.updated_at,
        current_version=_current_version_schema(db, recipe),
    )


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.post("", response_model=RecipeDetail, status_code=201)
def create_recipe(
    body: RecipeCreate,
    owner: AnonSession = Depends(get_owner),
    db: Session = Depends(get_db),
) -> RecipeDetail:
    recipe = Recipe(owner_anon_id=owner.id, name=body.name)
    db.add(recipe)
    db.flush()  # populate recipe.id

    version = RecipeVersion(
        recipe_id=recipe.id,
        version_no=1,
        script=body.script,
        params_json=body.params,
        param_values_json=body.param_values,
        inputs_json=body.inputs,
        prompt=body.prompt,
    )
    db.add(version)
    db.flush()  # populate version.id

    recipe.current_version_id = version.id
    db.commit()
    db.refresh(recipe)
    return _detail(db, recipe)


@router.get("", response_model=list[RecipeListItem])
def list_recipes(
    owner: AnonSession = Depends(get_owner),
    db: Session = Depends(get_db),
) -> list[RecipeListItem]:
    count_col = func.count(RecipeVersion.id)
    rows = db.execute(
        select(
            Recipe.id,
            Recipe.name,
            count_col,
            Recipe.updated_at,
        )
        .outerjoin(RecipeVersion, RecipeVersion.recipe_id == Recipe.id)
        .where(Recipe.owner_anon_id == owner.id)
        .group_by(Recipe.id)
        .order_by(Recipe.updated_at.desc())
    ).all()
    return [
        RecipeListItem(id=r_id, name=name, version_count=count, updated_at=updated_at)
        for (r_id, name, count, updated_at) in rows
    ]


@router.get("/{recipe_id}", response_model=RecipeDetail)
def get_recipe(
    recipe_id: str,
    owner: AnonSession = Depends(get_owner),
    db: Session = Depends(get_db),
) -> RecipeDetail:
    recipe = _get_owned_recipe(db, owner, recipe_id)
    return _detail(db, recipe)


@router.post("/{recipe_id}/versions", response_model=RecipeDetail, status_code=201)
def add_version(
    recipe_id: str,
    body: VersionCreate,
    owner: AnonSession = Depends(get_owner),
    db: Session = Depends(get_db),
) -> RecipeDetail:
    recipe = _get_owned_recipe(db, owner, recipe_id)

    max_no = db.execute(
        select(func.max(RecipeVersion.version_no)).where(
            RecipeVersion.recipe_id == recipe.id
        )
    ).scalar_one()
    next_no = (max_no or 0) + 1

    version = RecipeVersion(
        recipe_id=recipe.id,
        version_no=next_no,
        script=body.script,
        params_json=body.params,
        param_values_json=body.param_values,
        inputs_json=body.inputs,
        prompt=body.prompt,
    )
    db.add(version)
    db.flush()

    recipe.current_version_id = version.id
    db.commit()
    db.refresh(recipe)
    return _detail(db, recipe)


@router.get("/{recipe_id}/versions", response_model=list[VersionListItem])
def list_versions(
    recipe_id: str,
    owner: AnonSession = Depends(get_owner),
    db: Session = Depends(get_db),
) -> list[VersionListItem]:
    recipe = _get_owned_recipe(db, owner, recipe_id)
    versions = db.execute(
        select(RecipeVersion)
        .where(RecipeVersion.recipe_id == recipe.id)
        .order_by(RecipeVersion.version_no.desc())
    ).scalars().all()
    return [
        VersionListItem(
            id=v.id,
            version_no=v.version_no,
            created_at=v.created_at,
            prompt=v.prompt,
        )
        for v in versions
    ]


@router.patch("/{recipe_id}", response_model=RecipeDetail)
def rename_recipe(
    recipe_id: str,
    body: RecipeRename,
    owner: AnonSession = Depends(get_owner),
    db: Session = Depends(get_db),
) -> RecipeDetail:
    recipe = _get_owned_recipe(db, owner, recipe_id)
    recipe.name = body.name
    db.commit()
    db.refresh(recipe)
    return _detail(db, recipe)


@router.delete("/{recipe_id}", status_code=204)
def delete_recipe(
    recipe_id: str,
    owner: AnonSession = Depends(get_owner),
    db: Session = Depends(get_db),
) -> None:
    recipe = _get_owned_recipe(db, owner, recipe_id)
    db.delete(recipe)
    db.commit()
